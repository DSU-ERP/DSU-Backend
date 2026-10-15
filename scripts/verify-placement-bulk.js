import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPool} from '../src/integrations/supabase/db.js';
const pool=createPool(process.env.DATABASE_ADMIN_URL),c=await pool.connect();
try {
 await c.query('BEGIN');
 const officer=randomUUID(),company=randomUUID(),drive=randomUUID();
 await c.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)",[officer,`verify-${officer}@example.invalid`]);
 await c.query('INSERT INTO placement.officers(user_id) VALUES($1)',[officer]);
 await c.query("INSERT INTO placement.companies(id,name) VALUES($1,$2)",[company,`Bulk fixture ${company}`]);
 await c.query("INSERT INTO placement.drives(id,company_id,title,package_lpa,academic_year,batch,min_cgpa,max_backlogs,branches,rounds) VALUES($1,$2,'Bulk fixture',8,'2097-98','2098',6.75,0,ARRAY['QA-BULK'],ARRAY['Interview'])",[drive,company]);
 const ids=(await c.query("INSERT INTO erp.students(enrollment_no,full_name,source_batch,source_hash,department_short_name) SELECT $1||'-'||n,'Synthetic candidate '||n,'2098','fixture','QA-BULK' FROM generate_series(1,500) n RETURNING id",[officer])).rows.map(r=>r.id);
 await c.query('INSERT INTO erp.academics(student_id,cgpa,current_backlog) SELECT unnest($1::uuid[]),8,0',[ids]);
 await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:officer,role:'authenticated'})]);await c.query('SET LOCAL ROLE authenticated');
 const mutate=async(action,payload)=>(await c.query('SELECT public.dsu_placement_mutate($1,$2,$3) AS v',[action,payload,randomUUID()])).rows[0].v.data;
 const start=performance.now();
 assert.equal((await mutate('interest.record',{drive_id:drive,student_ids:ids,state:'interested'})).count,500);
 assert.equal((await mutate('registration.interested',{drive_id:drive})).count,500);
 assert.equal((await mutate('registration.interested',{drive_id:drive})).count,0);
 await c.query('ROLLBACK');
 console.log(JSON.stringify({passed:true,candidates:500,milliseconds:Math.round(performance.now()-start),fixtures:'rolled back',checks:['bulk interest','bulk registration','repeat registration does not duplicate']}));
}catch(e){await c.query('ROLLBACK');console.error('Bulk validation failed:',e.code||'VALIDATION',e.message);process.exitCode=1;}finally{c.release();await pool.end();}
