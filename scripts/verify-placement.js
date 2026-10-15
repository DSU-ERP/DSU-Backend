import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPool} from '../src/integrations/supabase/db.js';
import {placementEligibility} from '../src/modules/analytics/placementPolicy.js';
const pool=createPool(process.env.DATABASE_ADMIN_URL);
const c=await pool.connect();
try {
  await c.query('BEGIN');
  if(process.argv.includes('--preview')) await c.query(await readFile(new URL('../supabase/migrations/005_placement_eligibility.sql',import.meta.url),'utf8'));
  const values=['10','9.25','8.50','8.499','8.49','7.50','6.75','6.749999999999999999999','6.749','6.74','6.50','6.49','5','0',null,'-1','10.001','NaN','Infinity'];
  const results=(await c.query('SELECT erp.placement_eligible(v::numeric) AS eligible FROM unnest($1::text[]) WITH ORDINALITY t(v,n) ORDER BY n',[values])).rows;
  assert.deepEqual(results.map(r=>r.eligible),values.map(placementEligibility));
  const actor=(await c.query("SELECT user_id FROM erp.memberships WHERE role='admin' ORDER BY created_at LIMIT 1")).rows[0].user_id;
  await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,role:'authenticated'})]);
  await c.query('SET LOCAL ROLE authenticated');
  const rpc=async(path,query)=>(await c.query('SELECT public.dsu_batch_read($1,$2) AS payload',[path,query])).rows[0].payload.data;
  const data=await rpc('/batches',{batch:'2028'});
  const summary=(await c.query("SELECT public.dsu_portal_read('/analytics',$1) AS payload",[{batch:'2028'}])).rows[0].payload.data.summary;
  assert.equal(data.summary.total,summary.total);
  assert.equal(data.summary.eligible,summary.categories.reduce((sum,r)=>sum+r.eligibleCount,0));
  for(const row of [data.summary,...data.departments]) {
    assert.equal(row.eligible+row.not_eligible+row.unclassified,row.total);
    assert.equal(row.at_least_six+row.below_six+row.unclassified,row.total);
  }
  for(const key of ['total','eligible','not_eligible','unclassified'])assert.equal(data.departments.reduce((sum,d)=>sum+d[key],0),data.summary[key]);
  const list=await rpc('/batches/students',{batch:'2028',limit:'25'});
  for(const student of list.students)assert.equal(student.placement_eligible,placementEligibility(student.cgpa));
  const category=(await c.query("SELECT public.dsu_portal_read('/student-categories/medium',$1) AS payload",[{batch:'2028'}])).rows[0].payload.data;
  for(const student of category.students)assert.equal(student.placement_eligible,true);
  await c.query('ROLLBACK');
  console.log(JSON.stringify({passed:true,boundaries:values.length,batch:'2028',departments:data.departments.length,total:data.summary.total,eligible:data.summary.eligible,notEligible:data.summary.not_eligible,unclassified:data.summary.unclassified,audits:'rolled back'}));
}catch(e){await c.query('ROLLBACK');console.error('Placement verification failed:',e.code,e.message);process.exitCode=1;}
finally{c.release();await pool.end();}
