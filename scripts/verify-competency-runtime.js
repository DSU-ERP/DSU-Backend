import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {competencyEnabled} from '../src/modules/competency/gate.js';

if(!competencyEnabled(process.env))throw new Error('Only the dedicated testing runtime is supported.');
const accounts=JSON.parse(await readFile(new URL('../.local/competency-test-accounts.json',import.meta.url),'utf8'));
const origin='http://127.0.0.1:4101';
const tokens={};
const checks=[];
try {
 for(const role of ['student','officer']) {
  const {email,password}=accounts[role];
  const response=await fetch(process.env.SUPABASE_URL+'/auth/v1/token?grant_type=password',{
   method:'POST',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
   body:JSON.stringify({email,password}),signal:AbortSignal.timeout(20000),
  });
  assert.equal(response.status,200,role+' testing Auth login');
  tokens[role]=(await response.json()).access_token;
  checks.push(role+' Supabase Auth login');
 }
 async function call(role,path,expected=200,body) {
  const response=await fetch(origin+'/api/v1'+path,{
   method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens[role],'Content-Type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000),
  });
  const payload=await response.json();
  assert.equal(response.status,expected,path+': '+(payload.error?.code??response.status));
  return payload.data;
 }
 const catalog=await call('officer','/competency/catalog');
 assert.equal(catalog.competencies.length,148);assert.equal(catalog.roles.length,60);
 const profile=await call('student','/student/career-intelligence');
 assert.equal(profile.identity.id,accounts.student.studentId);
 checks.push('own canonical student and 148 competencies / 60 roles');
 await call('student','/placement/talent-intelligence',403);
 await call('officer','/student/career-intelligence',404);
 checks.push('student/officer access separation');
 const overview=await call('officer','/placement/talent-intelligence');
 assert.equal(overview.counts.students,100);
 const role=catalog.roles.find(r=>r.id==='software-development-engineer');
 const template=role.templates.find(t=>t.status==='simulated');
 const cohort=await call('officer','/placement/talent-intelligence/cohort?templateId='+template.id);
 assert.equal(cohort.cohortTotal,100);
 checks.push('restricted runtime cohort calculation');
 if(process.argv.includes('--ai')) {
  const evidence=profile.evidence.find(e=>e.source_kind==='synthetic_validation')??profile.evidence.find(e=>e.is_synthetic);
  assert.ok(evidence);
  const extraction=await call('student','/competency/extract',200,{evidenceIds:[evidence.id]});
  assert.ok(Array.isArray(extraction.content.observations));
  if(evidence.source_kind==='synthetic_validation')assert.ok(extraction.content.observations.length>0,'Concrete API fixture must yield at least one grounded observation.');
  for(const item of extraction.content.observations) {
   assert.equal(item.evidenceId,evidence.id);
   assert.ok(evidence.description.includes(item.quote));
  }
  checks.push('real OpenRouter extraction: '+extraction.content.observations.length+' validated observations');
 }
 const report={project:'bsiibnoqfuyxieogions',verifiedAt:new Date().toISOString(),checks,passed:true};
 await writeFile(new URL('../.local/competency-runtime-verification.json',import.meta.url),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
} catch(error) {
 console.error(JSON.stringify({passed:false,message:error.message,completedChecks:checks}));process.exitCode=1;
}
