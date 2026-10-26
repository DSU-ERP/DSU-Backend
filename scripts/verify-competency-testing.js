import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createPool} from '../src/integrations/supabase/db.js';
import {assertTestingTarget,assertTestingMarker,TESTING_PROJECT_REF} from '../src/platform/testing-guard.js';
import {rankComparable} from '../src/modules/competency/roles/engine.js';
assertTestingTarget();
const pool=createPool(process.env.TESTING_DATABASE_ADMIN_URL,{...process.env,DATABASE_CA_PATH:process.env.TESTING_DATABASE_CA_PATH,DATABASE_POOL_MAX:'1',DATABASE_QUERY_TIMEOUT_MS:'120000',DATABASE_STATEMENT_TIMEOUT_MS:'120000'});
try{
 const c=await pool.connect();
 try{
  await assertTestingMarker(c);
  const previous=JSON.parse(await readFile(new URL('../.local/competency-testing-install.json',import.meta.url),'utf8'));
  const actual={};
  for(const [key,schema] of [['students','erp'],['academics','erp'],['contacts','erp'],['offers','placement']])actual[key]=(await c.query(`SELECT count(*)::int AS count,md5(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text)) AS hash FROM ${schema}.${key} t`)).rows[0];
  assert.deepEqual(actual,previous.canonical);
  const counts=(await c.query(`SELECT (SELECT count(*)::int FROM competency.catalog) competencies,(SELECT count(*)::int FROM competency.roles) roles,(SELECT count(*)::int FROM competency.evidence) evidence,(SELECT count(*)::int FROM competency.assessments) assessments,(SELECT count(*)::int FROM competency.snapshots) snapshots,(SELECT count(DISTINCT student_id)::int FROM competency.evidence) students_with_evidence`)).rows[0];
  assert.equal(counts.competencies,148);assert.equal(counts.roles,60);assert.equal(counts.students_with_evidence,100);
  assert.equal((await c.query('SELECT count(*)::int n FROM competency.evidence e LEFT JOIN testing.synthetic_students t ON t.student_id=e.student_id WHERE e.is_synthetic AND t.student_id IS NULL')).rows[0].n,0);
  const snapshots=(await c.query('SELECT s.*,t.role_id FROM competency.snapshots s JOIN competency.templates t ON t.id=s.template_id WHERE s.is_synthetic ORDER BY s.student_id')).rows;
  let formulas=0,lowCoverage=0;
  for(const s of snapshots){
   const r=s.result,coverage=r.inputs.reduce((sum,i)=>sum+(i.level===null?0:i.weight),0);
   const score=coverage?100*r.inputs.reduce((sum,i)=>sum+(i.level===null?0:i.weight*i.level/4),0)/coverage:null;
   assert.equal(r.coverage,coverage);assert.equal(r.alignment,score);assert.equal(r.simulated,true);formulas++;
   if(coverage<r.minimumCoverage)lowCoverage++;
  }
  const allocations=(await c.query("SELECT cohort->>'family' family,count(DISTINCT student_id)::int students FROM competency.snapshots WHERE is_synthetic GROUP BY cohort->>'family' ORDER BY family")).rows;
  assert.equal(allocations.reduce((sum,r)=>sum+r.students,0),100);
  const tiedRole=snapshots.filter(s=>s.role_id==='software-development-engineer'&&s.result.coverage===100).map(s=>({studentId:s.student_id,result:s.result}));
  const ranked=rankComparable(tiedRole);const tie=ranked.some((r,i)=>ranked.some((q,j)=>i!==j&&q.rank===r.rank&&q.result.alignment===r.result.alignment));assert.equal(tie,true);
  const edgeCases=(await c.query(`SELECT
 count(DISTINCT a.student_id) FILTER(WHERE a.cgpa>=8.5 AND c.level<=1) AS high_cgpa_weak_sample,
 count(DISTINCT a.student_id) FILTER(WHERE a.cgpa<8.5 AND c.level>=3) AS moderate_cgpa_strong_sample
 FROM erp.academics a JOIN competency.assessments c ON c.student_id=a.student_id WHERE c.is_synthetic`)).rows[0];
  assert.ok(Number(edgeCases.high_cgpa_weak_sample)>0);assert.ok(Number(edgeCases.moderate_cgpa_strong_sample)>0);
  const sourceStates=(await c.query('SELECT review_status,count(*)::int count FROM competency.evidence GROUP BY review_status ORDER BY review_status')).rows;
  const report={project:TESTING_PROJECT_REF,verifiedAt:new Date().toISOString(),counts,allocations,formulaSnapshotsVerified:formulas,lowCoverageSnapshots:lowCoverage,tiedRanksVerified:tie,edgeCases,sourceStates,canonicalRecordsUnchanged:true,externalPlatformRequests:0,limitations:['Synthetic results validate processing behavior, not real-world assessment correctness.','Institutional approval is still required for proposed rubric anchors and role weights.']};
  await writeFile(new URL('../.local/competency-testing-verification.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{c.release();}
}catch(e){console.error(JSON.stringify({error:'COMPETENCY_VERIFICATION_FAILED',message:e.message}));process.exitCode=1;}finally{await pool.end();}
