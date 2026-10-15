import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from '../src/integrations/supabase/db.js';
const pool=createPool(process.env.DATABASE_ADMIN_URL);
const c=await pool.connect();
let checks=0;
try {
 await c.query('BEGIN');
 if(process.argv.includes('--preview')) await c.query(await readFile(new URL('../supabase/migrations/004_batch_drilldown.sql',import.meta.url),'utf8'));
 if(process.argv.includes('--preview') || process.argv.includes('--preview-placement')) await c.query(await readFile(new URL('../supabase/migrations/005_placement_eligibility.sql',import.meta.url),'utf8'));
 const users=Object.fromEntries(['admin','staff','student','unlinked'].map(r=>[r,randomUUID()]));
 for(const id of Object.values(users)) await c.query("INSERT INTO auth.users(id,aud,role,email) VALUES ($1,'authenticated','authenticated',$2)",[id,`batch-test-${id}@example.invalid`]);
 const prefix=`BATCH-${randomUUID()}`;
 const values=['10','8.50','8.499','6.75','6.749','5','0',null];
 const ids=[];
 for(let i=0;i<values.length;i++) {
   const id=randomUUID();ids.push(id);
   await c.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name,admission_quota,current_semester,admission_year) VALUES ($1,$2,$3,'2099','test',$4,$5,$6,'2095')",
     [id,`${prefix}-${i}`,`Student ${7-i}`,i%2?'TEST-A':'TEST-B',i%2?'CET':'DSAT',i%2?'10':'2']);
   await c.query('INSERT INTO erp.academics(student_id,cgpa,sgpa,attendance,current_backlog) VALUES ($1,$2,$2,$3,$4)',[id,values[i],i*10,i]);
   await c.query('INSERT INTO erp.contacts(student_id,details) VALUES ($1,$2)',[id,JSON.stringify({email:'private@example.invalid',gender:i%2?'F':'M',fatherName:'Private parent'})]);
 }
 for(const role of ['admin','staff','student']) await c.query('INSERT INTO erp.memberships(user_id,role,student_id) VALUES ($1,$2,$3)',[users[role],role,role==='student'?ids[0]:null]);
 const become=async role=>{
   await c.query('RESET ROLE');await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:users[role],role:'authenticated'})]);
   await c.query(`SET LOCAL ROLE ${role==='anon'?'anon':'authenticated'}`);
 };
 const rpc=async(path,q={})=>(await c.query('SELECT public.dsu_batch_read($1,$2) AS result',[path,q])).rows[0].result.data;
 const denied=async(fn,code)=>{await c.query('SAVEPOINT denied');await assert.rejects(fn,e=>e.code===code);await c.query('ROLLBACK TO SAVEPOINT denied');checks++;};
 const q={batch:'2099',search:prefix};
 await become('anon');await denied(()=>rpc('/batches',q),'42501');
 for(const role of ['student','unlinked']){await become(role);await denied(()=>rpc('/batches',q),'PT403');}
 await become('staff');
 const staff=await rpc('/batches/students',q);
 assert.equal(staff.summary.total,8);assert.equal(staff.genderAvailable,false);assert.ok(staff.students.every(s=>s.gender===null));checks++;
 const staffDetail=await rpc(`/batches/student/${ids[0]}`,q);
 assert.equal(staffDetail.contact,null);assert.equal(staffDetail.fees,null);assert.equal(staffDetail.admission_year,'2095');checks++;
 await denied(()=>rpc('/batches/export',q),'PT403');
 await become('admin');
 const summary=await rpc('/batches',q);
 assert.equal(summary.summary.total,8);assert.equal(summary.summary.valid,7);assert.equal(summary.summary.unclassified,1);
 assert.equal(summary.summary.male,4);assert.equal(summary.summary.female,4);assert.equal(summary.summary.eligible,4);assert.equal(summary.summary.not_eligible,3);
 assert.equal(summary.placementPolicy.minimumCgpa,'6.75');
 assert.equal(summary.departments.reduce((n,d)=>n+d.eligible+d.not_eligible+d.unclassified,0),8);
 assert.equal(summary.departments.reduce((n,d)=>n+d.total,0),8);
 assert.equal(summary.summary.at_least_six+summary.summary.below_six+summary.summary.unclassified,8);checks++;
 assert.equal((await rpc('/batches/students',{...q,department:'TEST-A'})).pagination.total,4);checks++;
 assert.equal((await rpc('/batches/students',{...q,quota:'DSAT'})).pagination.total,4);checks++;
 assert.equal((await rpc('/batches/students',{...q,category:'medium'})).pagination.total,2);checks++;
 assert.equal((await rpc('/batches/students',{...q,category:'unclassified'})).students[0].id,ids[7]);checks++;
 const list=await rpc('/batches/students',q);
 assert.deepEqual(list.students.map(s=>s.cgpa),values);checks++;
 assert.deepEqual(list.students.map(s=>s.placement_eligible),[true,true,true,true,false,false,false,null]);checks++;
 assert.equal((await rpc('/batches/students',{...q,direction:'asc'})).students[0].cgpa,'0');checks++;
 assert.equal((await rpc('/batches/students',{...q,sort:'name',direction:'asc'})).students[0].full_name,'Student 0');checks++;
 assert.equal((await rpc('/batches/students',{...q,sort:'semester',direction:'asc'})).students[0].current_semester,'2');checks++;
 for(const sort of ['sgpa','attendance','backlogs','usn']){const list=await rpc('/batches/students',{...q,sort,direction:'desc'});assert.equal(list.students.length,8);checks++;}
 const page=await rpc('/batches/students',{...q,limit:'2',page:'2'});assert.equal(page.students[0].cgpa,'8.499');checks++;
 assert.equal((await rpc('/batches/students',{...q,limit:'2',page:'999'})).pagination.page,4);checks++;
 assert.equal((await rpc('/batches/students',{...q,search:'%_'})).pagination.total,0);checks++;
 const detail=await rpc(`/batches/student/${ids[0]}`,q);assert.equal(detail.contact.fatherName,'Private parent');assert.equal(detail.admission_quota,'DSAT');assert.equal(detail.placement_eligible,true);checks++;
 await denied(()=>rpc(`/batches/student/${ids[0]}`,{...q,batch:'2098'}),'PT404');
 await denied(()=>rpc('/batches/students',{...q,sort:'cgpa;DROP TABLE erp.students'}),'PT400');
 await denied(()=>rpc('/batches/students',{...q,page:'0'}),'PT400');
 const exported=await rpc('/batches/export',{...q,limit:'1'});assert.equal(exported.students.length,8);checks++;
 for(let i=0;i<4;i++) await rpc('/batches/export',q);
 await denied(()=>rpc('/batches/export',q),'PT429');
 await c.query('ROLLBACK');console.log(JSON.stringify({passed:true,checks,syntheticData:'rolled back'}));
}catch(e){await c.query('ROLLBACK');console.error('Batch verification failed:',e.code,e.message,e.where);process.exitCode=1;}
finally{c.release();await pool.end();}
