import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRole,rankComparable,validateRequirements} from '../src/modules/competency/roles/engine.js';
import {assessDimensions,proposedRubric} from '../src/modules/competency/assessment/rubrics.js';
import {validateExtraction} from '../src/modules/competency/evidence/extraction.js';
import {catalogs} from '../src/modules/competency/data/seed.js';
import {competencyEnabled} from '../src/modules/competency/gate.js';
const template={id:'role-v1',assessmentSet:'exam-v1',minimumCoverage:70,requirements:[{code:'SW-01',rubricId:'r1',weight:70},{code:'SW-02',rubricId:'r2',weight:30}]};
const assessment=(code,level,rubricId)=>({id:code,code,level,rubricId,assessmentSet:'exam-v1',status:'reviewed',simulated:false,evidenceValid:true});
test('catalog counts and family counts match specification',async()=>{const {competencies,roles}=await catalogs();assert.equal(roles.length,60);assert.equal(new Set(roles.map(r=>r.id)).size,60);assert.equal(competencies.length,148);assert.equal(new Set(competencies.map(c=>c.code)).size,148);for(const [f,n] of Object.entries({GEN:20,SW:16,AI:14,INF:14,MEC:10,ECE:12,CIV:10,CORE:10,MKT:12,SAL:12,BUS:18}))assert.equal(competencies.filter(c=>c.family===f).length,n);});
test('weighted score, coverage, zero and missing are distinct',()=>{
 let r=evaluateRole(template,[assessment('SW-01',4,'r1'),assessment('SW-02',2,'r2')]);assert.equal(r.alignment,85);assert.equal(r.coverage,100);
 r=evaluateRole(template,[assessment('SW-01',4,'r1')]);assert.equal(r.alignment,100);assert.equal(r.coverage,70);
 r=evaluateRole(template,[assessment('SW-02',4,'r2')]);assert.equal(r.alignment,100);assert.equal(r.state,'Needs Assessment');
 r=evaluateRole(template,[assessment('SW-01',0,'r1')]);assert.equal(r.alignment,0);assert.equal(r.coverage,70);
 r=evaluateRole(template,[]);assert.equal(r.alignment,null);assert.equal(r.coverage,0);
});
test('invalid role weights and duplicate dimensions are rejected',()=>{for(const weight of [-1,0,NaN,Infinity,99,101])assert.throws(()=>validateRequirements([{code:'SW-01',rubricId:'r',weight}]));assert.throws(()=>validateRequirements([{code:'SW-01',rubricId:'r',weight:50},{code:'SW-01',rubricId:'r',weight:50}]));});
test('pending, conflict, expired, wrong rubric and simulation cannot score as reviewed',()=>{
 for(const change of [{status:'pending'},{conflict:true},{evidenceValid:false},{expiresAt:'2000-01-01'},{rubricId:'r-other'},{assessmentSet:'other'},{simulated:true},{level:null},{level:5}])assert.equal(evaluateRole(template,[{...assessment('SW-01',4,'r1'),...change}]).coverage,0);
 assert.equal(evaluateRole(template,[assessment('SW-01',4,'r1'),assessment('SW-01',2,'r1')]).coverage,0);
});
test('ties share dense rank and stable identity ordering, incompatible sets have no rank',()=>{
 const r=evaluateRole(template,[assessment('SW-01',3,'r1')]);const rows=[{studentId:'b',result:r},{studentId:'a',result:r}];
 assert.deepEqual(rankComparable(rows).map(r=>[r.studentId,r.rank]),[['a',1],['b',1]]);
 rows.push({studentId:'c',result:evaluateRole(template,[assessment('SW-01',3,'r1'),assessment('SW-02',3,'r2')])});assert.ok(rankComparable(rows).every(r=>r.rank===null));
});
test('every rubric criterion must be attempted, no missing to zero',()=>{const rubric=proposedRubric('SW-06','API Development');assert.throws(()=>assessDimensions(rubric,{}));assert.equal(assessDimensions(rubric,Object.fromEntries(rubric.dimensions.map(d=>[d.key,4]))),4);});
test('grounded AI output rejects invented IDs, quotes, codes and scores',()=>{
 const evidence=[{id:'11111111-1111-4111-a111-111111111111',source_ref:'work:1',description:'Implemented request validation and tests.'}];
 const valid={observations:[{evidenceId:evidence[0].id,sourceRef:'work:1',quote:'request validation',competencyCode:'SW-06',interpretation:'Potential API evidence',limitations:'Needs review'}]};
 assert.equal(validateExtraction(valid,evidence,['SW-06']).observations.length,1);
 for(const change of [{quote:'invented evidence'},{competencyCode:'SW-99'},{sourceRef:'work:2'},{score:4}])assert.throws(()=>validateExtraction({observations:[{...valid.observations[0],...change}]},evidence,['SW-06']));
});
test('feature remains closed for production, unset flags and mixed targets',()=>{assert.equal(competencyEnabled({}),false);assert.equal(competencyEnabled({COMPETENCY_TESTING:'true',DSU_ENVIRONMENT:'production'}),false);assert.equal(competencyEnabled({COMPETENCY_TESTING:'true',DSU_ENVIRONMENT:'testing',SUPABASE_URL:'https://bsiibnoqfuyxieogions.supabase.co',DATABASE_URL:'postgresql://dsu_api.idioblehzhaibtgotfjk:x@aws-0-ap-southeast-2.pooler.supabase.com/postgres'}),false);});
