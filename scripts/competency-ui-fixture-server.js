// Local browser-test database only. Never reads an environment file or connects
// to Supabase. The real route handlers and RLS run against in-memory PostgreSQL.
import {readFile} from 'node:fs/promises';
import {testDatabase} from '../test/helpers/database.js';
import {seedCatalogs,seedFixtures,stableId} from '../src/modules/competency/data/seed.js';
import {buildApp} from '../src/app.js';
const {operator,pool}=await testDatabase();
for(const name of ['001_synthetic_student_placement_import.sql','002_competency_intelligence.sql','003_competency_evidence_guards.sql'])await operator.query(await readFile(new URL('../supabase/testing-migrations/'+name,import.meta.url),'utf8'));
await operator.query('BEGIN');
for(let i=0;i<100;i++){
 const id=stableId('ui-student:'+i),usn=`SYN${String(i).padStart(3,'0')}`;
 await operator.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,department_short_name,source_hash) VALUES($1,$2,$3,'2028','TEST','fixture')",[id,usn,`Synthetic Student ${i}`]);
 await operator.query("INSERT INTO testing.synthetic_students(student_id,source_record,enrollment_no,source_hash,source_data) VALUES($1,$2,$2,'fixture','{}')",[id,usn]);
}
const catalog=await seedCatalogs(operator);await seedFixtures(operator,catalog);
const student=stableId('ui-auth-student'),officer=stableId('ui-auth-officer');
for(const id of [student,officer])await operator.query('INSERT INTO auth.users(id) VALUES($1)',[id]);
await operator.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)",[student,stableId('ui-student:0')]);
await operator.query('INSERT INTO placement.officers(user_id) VALUES($1)',[officer]);
await operator.query("INSERT INTO competency.permissions(user_id,permission) SELECT $1,unnest(ARRAY['review','manage_rubrics','approve_shortlist'])",[officer]);
await operator.query('COMMIT');
const app=await buildApp({pool,env:{SERVICE_TOKEN:'x'.repeat(40),COMPETENCY_TESTING:'true',DSU_ENVIRONMENT:'testing',SUPABASE_URL:'https://bsiibnoqfuyxieogions.supabase.co',DATABASE_URL:'postgresql://dsu_api.bsiibnoqfuyxieogions:fake@aws-0-ap-southeast-2.pooler.supabase.com/postgres',COMPETENCY_WORKER:'off'},verify:async token=>{if(![student,officer].includes(token))throw Error('Unknown test actor');return {id:token};},logger:false,research:{enabled:false}});
await app.listen({port:0,host:'127.0.0.1'});
console.log(JSON.stringify({port:app.server.address().port,student,officer}));
process.on('SIGTERM',()=>void app.close());
