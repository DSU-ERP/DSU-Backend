import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {createPool} from '../src/integrations/supabase/db.js';
import {assertTestingTarget,assertTestingMarker,TESTING_PROJECT_REF} from '../src/platform/testing-guard.js';
assertTestingTarget();
const key=process.env.TESTING_SUPABASE_SECRET_KEY;
if(!key)throw new Error('TESTING_SUPABASE_SECRET_KEY must be supplied in the ignored testing operator environment.');
const origin='https://'+TESTING_PROJECT_REF+'.supabase.co';
const pool=createPool(process.env.TESTING_DATABASE_ADMIN_URL,{...process.env,DATABASE_CA_PATH:process.env.TESTING_DATABASE_CA_PATH,DATABASE_POOL_MAX:'1'});
const localFile=new URL('../.local/competency-test-accounts.json',import.meta.url);
try{
 const c=await pool.connect();
 try{
  await assertTestingMarker(c);
  const student=(await c.query('SELECT s.id,s.full_name,s.enrollment_no FROM testing.synthetic_students t JOIN erp.students s ON s.id=t.student_id ORDER BY t.enrollment_no LIMIT 1')).rows[0];
  if(!student)throw new Error('Existing synthetic student required.');
  let credentials;try{credentials=JSON.parse(await readFile(localFile,'utf8'));}catch{credentials={};}
  const accounts=[];
  for(const role of ['student','officer']){
   const email=`competency-${role}@dsu-testing.invalid`;
   const existing=(await c.query('SELECT id FROM auth.users WHERE email=$1 AND deleted_at IS NULL',[email])).rows[0];
   let id=existing?.id,password=credentials[role]?.password;
   if(!id){
    password=randomBytes(24).toString('base64url');
    const response=await fetch(origin+'/auth/v1/admin/users',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({email,password,email_confirm:true,user_metadata:{testing_account:true}}),signal:AbortSignal.timeout(20000)});
    if(!response.ok){await response.body?.cancel();throw new Error('Testing Auth account creation failed with HTTP '+response.status);}
    id=(await response.json()).id;
    if(!id)throw new Error('Auth account identifier missing.');
    credentials[role]={email,password,id,...(role==='student'?{studentId:student.id,usn:student.enrollment_no}:{} )};
    await mkdir(new URL('../.local/',import.meta.url),{recursive:true});
    await writeFile(localFile,JSON.stringify(credentials,null,2));
   }
   if(role==='student')await c.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2) ON CONFLICT(user_id) DO NOTHING",[id,student.id]);
   else{
    await c.query('INSERT INTO placement.officers(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',[id]);
    await c.query("INSERT INTO competency.permissions(user_id,permission) SELECT $1,unnest(ARRAY['review','manage_rubrics','approve_shortlist']) ON CONFLICT DO NOTHING",[id]);
   }
   accounts.push({role,email,linked:true});
  }
  if(process.argv.includes('--configure-runtime')) {
  let existingRuntime;try{existingRuntime=parseEnv(await readFile(new URL('../.env.competency-testing',import.meta.url),'utf8'));}catch{}
  let databaseUrl=existingRuntime?.DATABASE_URL;
  if(!databaseUrl){
   const password=randomBytes(36).toString('base64url');
   const statement=(await c.query("SELECT format('ALTER ROLE dsu_api LOGIN PASSWORD %L',$1::text) sql",[password])).rows[0].sql;
   await c.query(statement);
   const url=new URL(process.env.TESTING_DATABASE_ADMIN_URL);url.username='dsu_api.'+TESTING_PROJECT_REF;url.password=password;databaseUrl=url.toString();
  }
  // Reuse only the existing AI configuration, never a normal DB or auth target.
  let normal={};try{normal=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));}catch{}
  const publishable=process.env.TESTING_SUPABASE_PUBLISHABLE_KEY;
  if(!publishable)throw new Error('TESTING_SUPABASE_PUBLISHABLE_KEY is required.');
  const runtime={NODE_ENV:'development',DSU_ENVIRONMENT:'testing',COMPETENCY_TESTING:'true',SYNC_WORKER:'off',HOST:'127.0.0.1',PORT:'4101',DATABASE_URL:databaseUrl,DATABASE_SSL:'true',DATABASE_CA_PATH:process.env.TESTING_DATABASE_CA_PATH,SUPABASE_URL:origin,SUPABASE_PUBLISHABLE_KEY:publishable,SERVICE_TOKEN:existingRuntime?.SERVICE_TOKEN||randomBytes(36).toString('base64url'),CORS_ORIGINS:'http://localhost:4100,http://127.0.0.1:4100',OPENROUTER_API_KEY:normal.OPENROUTER_API_KEY||'',OPENROUTER_MODEL:normal.OPENROUTER_MODEL||'',OPENROUTER_PROVIDER:normal.OPENROUTER_PROVIDER||'',STUDENT_AI_MODEL:normal.STUDENT_AI_MODEL||''};
  const encode=object=>Object.entries(object).map(([k,v])=>k+'='+JSON.stringify(v??'')).join('\n')+'\n';
  await writeFile(new URL('../.env.competency-testing',import.meta.url),encode(runtime));
  const web=resolve(process.env.TESTING_WEB_ROOT||'../DSU-WEB/DSU_ERP');
  if(JSON.parse(await readFile(resolve(web,'package.json'),'utf8')).name!=='dsu-agentic-erp')throw new Error('Web project not recognized.');
  await writeFile(resolve(web,'.env.competency-testing'),encode({NODE_ENV:'development',DSU_ENVIRONMENT:'testing',COMPETENCY_TESTING:'true',NEXT_PUBLIC_SUPABASE_URL:origin,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:publishable,DSU_BACKEND_URL:'http://127.0.0.1:4101',OPENROUTER_API_KEY:normal.OPENROUTER_API_KEY||'',OPENROUTER_MODEL:normal.OPENROUTER_MODEL||'',OPENROUTER_PROVIDER:normal.OPENROUTER_PROVIDER||''}));
  }
  console.log(JSON.stringify({project:TESTING_PROJECT_REF,accounts,credentialsFile:'.local/competency-test-accounts.json',runtimeConfigured:process.argv.includes('--configure-runtime'),normalEnvironmentsUnchanged:true},null,2));
 }finally{c.release();}
}catch(e){console.error(JSON.stringify({error:'TESTING_PROVISION_FAILED',message:e.message}));process.exitCode=1;}finally{await pool.end();}
