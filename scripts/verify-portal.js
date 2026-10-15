import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/integrations/supabase/db.js';
import { classifyCgpa } from '../src/modules/analytics/categoryRules.js';

const pool = createPool(process.env.DATABASE_ADMIN_URL);
const client = await pool.connect();
let checks = 0;
try {
  await client.query('BEGIN');
  if (process.argv.includes('--preview')) {
    await client.query(await readFile(new URL('../supabase/migrations/003_supabase_portal_reads.sql', import.meta.url), 'utf8'));
  }
  const users = Object.fromEntries(['admin','staff','student','unlinked'].map(role => [role,randomUUID()]));
  for (const id of Object.values(users)) await client.query("INSERT INTO auth.users(id,aud,role,email) VALUES ($1,'authenticated','authenticated',$2)",[id,`portal-test-${id}@example.invalid`]);
  const prefix = `PORTAL-${randomUUID()}`;
  const cgpas = ['10','9.25','8.50','8.499','8.49','7.50','6.75','6.749','6.74','6.50','6.49','5','0',null,'8.50'];
  const ids = [];
  for (let i=0;i<cgpas.length;i++) {
    const id = randomUUID(); ids.push(id);
    await client.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name) VALUES ($1,$2,$3,'2099','test',$4)",[id,`${prefix}-${String(i).padStart(2,'0')}`,`Portal verification ${i}`,i%2?'TEST-A':'TEST-B']);
    await client.query('INSERT INTO erp.academics(student_id,cgpa,fees_paid) VALUES ($1,$2,100)',[id,cgpas[i]]);
    await client.query("INSERT INTO erp.contacts(student_id,details) VALUES ($1,'{\"email\":\"private@example.invalid\"}')",[id]);
  }
  for (const role of ['admin','staff','student']) await client.query('INSERT INTO erp.memberships(user_id,role,student_id) VALUES ($1,$2,$3)',[users[role],role,role==='student'?ids[0]:null]);
  const become = async role => {
    await client.query('RESET ROLE');
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[users[role]??'',JSON.stringify({sub:users[role],role:'authenticated'})]);
    await client.query(`SET LOCAL ROLE ${role==='anon'?'anon':'authenticated'}`);
  };
  const rpc = async(path,query={}) => (await client.query('SELECT public.dsu_portal_read($1,$2) AS result',[path,query])).rows[0].result;
  const denied = async(fn,code) => {
    await client.query('SAVEPOINT denied');
    await assert.rejects(fn, error => { if (code && error.code!==code) console.error('Expected',code,'received',error.code,error.message,error.where); return !code || error.code===code; });
    await client.query('ROLLBACK TO SAVEPOINT denied'); checks++;
  };
  await become('anon'); await denied(()=>rpc('/me'),'42501');
  await become('unlinked'); await denied(()=>rpc('/me'),'PT403');
  await become('student');
  assert.equal((await rpc('/me')).data.studentId,ids[0]); checks++;
  assert.equal((await rpc(`/students/${ids[0]}`)).data.academic.cgpa,'10'); checks++;
  await denied(()=>rpc(`/students/${ids[1]}`),'PT404');
  await denied(()=>rpc('/analytics'),'PT403');
  await denied(()=>client.query('SELECT * FROM erp.students'),'42501');
  await become('staff');
  const detail = (await rpc(`/students/${ids[0]}`)).data;
  assert.equal(detail.contact,null); assert.equal(detail.fees,null); checks++;
  await denied(()=>rpc('/student-categories/advanced/export'),'PT403');
  await denied(()=>rpc('/imports'),'PT403');
  await become('admin');
  const filters = {batch:'2099',search:prefix};
  const summary = (await rpc('/analytics',filters)).data.summary;
  assert.equal(summary.total,cgpas.length); assert.equal(summary.valid,14); assert.equal(summary.missing,1);
  assert.deepEqual(summary.categories.map(c=>c.count),[4,4,6]);
  assert.equal(summary.categories.reduce((n,c)=>n+c.count,0)+summary.unclassified,summary.total); checks++;
  for (const category of summary.categories) {
    const data = (await rpc(`/student-categories/${category.id}`,filters)).data;
    assert.equal(data.students.length,category.count);
    for (const s of data.students) assert.equal(classifyCgpa(s.cgpa),category.id);
    const exported = (await rpc(`/student-categories/${category.id}/export`,filters)).data;
    assert.equal(exported.students.length,category.count); checks++;
  }
  const advanced = (await rpc('/student-categories/advanced',filters)).data;
  assert.deepEqual(advanced.students.map(s=>s.rank),[1,2,3,3]); checks++;
  assert.equal((await rpc('/student-categories/medium',{...filters,limit:'1',page:'2'})).data.students[0].cgpa,'8.49'); checks++;
  assert.equal((await rpc('/student-categories/advanced',{...filters,page:'999'})).data.pagination.page,1); checks++;
  assert.equal((await rpc('/analytics',{...filters,department:'TEST-A'})).data.summary.total,7); checks++;
  assert.equal((await rpc('/analytics',{...filters,search:'%_'})).data.summary.total,0); checks++;
  const batch = (await rpc('/batch-analytics',filters)).data.batches[0];
  assert.equal(batch.advanced+batch.medium+batch['needs-improvement']+batch.unclassified,batch.total); checks++;
  assert.equal((await rpc('/students',filters)).pagination.total,15); checks++;
  assert.ok((await rpc('/overview')).data.students>=15); checks++;
  assert.ok(Array.isArray((await rpc('/imports')).data)); checks++;
  assert.ok((await rpc(`/students/${ids[0]}`)).data.contact); checks++;
  await denied(()=>rpc('/analytics',{user_id:users.admin}),'PT400');
  await denied(()=>rpc('/analytics',{page:'0'}),'PT400');
  await denied(()=>rpc('/student-categories/unknown'),'PT404');
  await rpc('/student-categories/advanced/export',filters);
  await rpc('/student-categories/advanced/export',filters);
  await denied(()=>rpc('/student-categories/advanced/export',filters),'PT429');
  await become('student');
  await client.query("SELECT set_config('app.user_id',$1,true)",[users.admin]);
  await denied(()=>rpc('/analytics'),'PT403');
  await client.query('RESET ROLE');
  for (const value of [...cgpas,'-1','10.01','NaN','Infinity','-Infinity','8.49999999999999999999','6.74999999999999999999']) {
    assert.equal((await client.query('SELECT erp.cgpa_category($1::numeric) AS category',[value])).rows[0].category,classifyCgpa(value)); checks++;
  }
  await client.query('ROLLBACK');
  console.log(JSON.stringify({passed:true,checks,syntheticData:'rolled back',migration:process.argv.includes('--preview')?'preview rolled back':'already installed'}));
} catch(error) {
  await client.query('ROLLBACK');
  console.error('Portal verification failed:',error.code,error.message,error.where);
  process.exitCode=1;
} finally { client.release(); await pool.end(); }
