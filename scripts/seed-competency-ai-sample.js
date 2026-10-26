import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from '../src/integrations/supabase/db.js';
import {assertTestingTarget,assertTestingMarker} from '../src/platform/testing-guard.js';
import {stableId} from '../src/modules/competency/data/seed.js';
assertTestingTarget();
const accounts=JSON.parse(await readFile(new URL('../.local/competency-test-accounts.json',import.meta.url),'utf8'));
const pool=createPool(process.env.TESTING_DATABASE_ADMIN_URL,{...process.env,DATABASE_CA_PATH:process.env.TESTING_DATABASE_CA_PATH,DATABASE_POOL_MAX:'1'});
try {
 const client=await pool.connect();
 try {
  await assertTestingMarker(client);
  const target=accounts.student.studentId;
  if(!(await client.query('SELECT 1 FROM testing.synthetic_students WHERE student_id=$1',[target])).rows.length)throw new Error('Existing synthetic student required.');
  const description='TEST-ONLY simulated API assessment, not a real student achievement. The work sample implements POST /orders with a JSON schema for item IDs and quantities. It rejects negative quantities with HTTP 400, checks ownership before retrieving an order, and returns HTTP 403 for another user. Six controlled tests cover valid requests, malformed JSON, negative quantities, missing fields, missing authentication and another user\'s order. The simulated author wrote the validation and tests; payment processing is outside this sample. These are fixture claims awaiting human review, not verified proficiency.';
  await client.query(`INSERT INTO competency.evidence(id,student_id,code,source_kind,source_ref,title,description,contribution,provenance,review_status,is_synthetic,import_batch,content_hash)
   VALUES($1,$2,'SW-06','synthetic_validation','fixture:ai-validation-api-v1','Test-only API evidence extraction sample',$3,'Simulated implementation of validation and tests.','synthetic_fixture','pending',true,'ai-validation-api-v1',$4) ON CONFLICT DO NOTHING`,[stableId('ai-validation-api-v1'),target,description,createHash('sha256').update(description).digest('hex')]);
  console.log(JSON.stringify({project:'bsiibnoqfuyxieogions',sample:'ai-validation-api-v1',synthetic:true,canonicalRecordsChanged:false}));
 }finally{client.release();}
}finally{await pool.end();}
