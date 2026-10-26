import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {proposedRubric,assessDimensions} from '../assessment/rubrics.js';
import {mappings,fixtureGroups} from './templates.js';
import {evaluateRole,validateRequirements} from '../roles/engine.js';
export const FIXTURE_BATCH='competency-pilot-20261023-v1';
export const stableId=(key)=>{const h=createHash('sha256').update(FIXTURE_BATCH+':'+key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export async function catalogs(){return {competencies:JSON.parse(await readFile(new URL('competencies.json',import.meta.url),'utf8')),roles:JSON.parse(await readFile(new URL('roles.json',import.meta.url),'utf8'))};}
export async function insertRows(c,table,rows){
 if(!rows.length)return;
 const columns=Object.keys(rows[0]);
 if(!/^[a-z_]+$/.test(table)||columns.some(x=>!/^[a-z_]+$/.test(x)))throw new Error('Invalid seed table');
 await c.query(`INSERT INTO competency.${table}(${columns.join(',')}) SELECT ${columns.join(',')} FROM jsonb_populate_recordset(NULL::competency.${table},$1::jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(rows)]);
}
export async function seedCatalogs(c){
 const {competencies,roles}=await catalogs();
 if(competencies.length!==148||roles.length!==60||new Set(competencies.map(x=>x.code)).size!==148)throw new Error('Invalid catalogs');
 await insertRows(c,'catalog',competencies); await insertRows(c,'roles',roles);
 const rubrics=[];
 for(const comp of competencies){
  const definition=proposedRubric(comp.code,comp.name);
  rubrics.push({id:stableId('rubric:draft:'+comp.code),code:comp.code,version:1,definition,status:'draft'});
  if(Object.values(mappings).some(m=>comp.code in m))rubrics.push({id:stableId('rubric:simulated:'+comp.code),code:comp.code,version:2,definition:{...definition,version:2,status:'simulated'},status:'simulated'});
 }
 await insertRows(c,'rubrics',rubrics);
 const templates=[],requirements=[];
 for(const [role,weights] of Object.entries(mappings))for(const status of ['draft','simulated']){
  const id=stableId('template:'+status+':'+role),assessment_set=status==='simulated'?FIXTURE_BATCH:'proposed-pilot-v1';
  templates.push({id,role_id:role,version:status==='draft'?1:2,status,assessment_set,minimum_coverage:70});
  const req=Object.entries(weights).map(([code,weight])=>({template_id:id,code,weight,rubric_id:stableId('rubric:'+status+':'+code)}));
  validateRequirements(req.map(r=>({...r,rubricId:r.rubric_id})));
  requirements.push(...req);
 }
 await insertRows(c,'templates',templates);await insertRows(c,'requirements',requirements);
 await insertRows(c,'metric_definitions',[{code:'artifact.criteria_observed',name:'Observed work-sample criteria',unit:'count',description:'Fixture observation only. A count is not a proficiency assessment.'}]);
 return {competencies,roles,rubrics,templates,requirements};
}
export async function seedFixtures(c,catalog){
 const students=(await c.query('SELECT student_id FROM testing.synthetic_students ORDER BY enrollment_no')).rows;
 if(students.length!==100)throw new Error('Exactly 100 existing synthetic students are required');
 const evidence=[],assessments=[],links=[],observations=[],snapshots=[];
 let i=0;
 for(const [family,count,role] of fixtureGroups)for(let j=0;j<count;j++,i++){
  const student_id=students[i].student_id;
  // Some students deliberately have a second assessed career area.
  const weights={...mappings[role],...(j===8?mappings['backend-developer']:{})};
  const sources=[];
  let k=0;
  for(const code of Object.keys(weights)){
   const rubric=catalog.rubrics.find(r=>r.code===code&&r.status==='simulated');
   const scenario=j===0?'weak-work-sample':j===1?'strong-work-sample':j===2?'low-coverage':j===3?'conflicting':j===4?'expired':j===5?'pending-review':j===6?'sync-unavailable':j===7?'missing-source':j===8?'multiple-career-areas':j>=count-2?'equal-scores':'standard';
   const review_status=j===3&&k===0?'conflicting':j===5&&k===0?'pending':j===6&&k===0?'unavailable':'accepted';
   const expires_at=j===4&&k===0?'2020-01-01T00:00:00.000Z':null;
   const id=stableId('evidence:'+student_id+':'+code);
   const description=`Simulated ${family} work sample for ${code}. Scenario: ${scenario}. No external account was accessed. The sample documents a student's own contribution, observed criteria, validation and limitations for testing the assessment pipeline only.`;
   const e={id,student_id,code,source_kind:'synthetic_work_sample',source_ref:`fixture:${FIXTURE_BATCH}/${i}/${code}`,title:`Simulated ${code} work sample`,description,contribution:'Simulated individual contribution; not a real credential.',provenance:'synthetic_fixture',review_status,is_synthetic:true,import_batch:FIXTURE_BATCH,content_hash:createHash('sha256').update(description).digest('hex'),observed_at:'2026-10-23T00:00:00.000Z',expires_at};
   evidence.push(e);
   observations.push({id:stableId('observation:'+id),evidence_id:id,student_id,metric_code:'artifact.criteria_observed',value:review_status==='unavailable'?null:rubric.definition.dimensions.length,observed_at:e.observed_at,expires_at});
   // Missing evidence remains unassessed. A reviewed attempted sample may be zero.
   const missing=(j===2&&k>0)||(j===7&&k===0);
   if(!missing){
    const level=j>=count-2?3:j===0?1:j===1?4:(i+k)%5;
    const dimensions=Object.fromEntries(rubric.definition.dimensions.map(d=>[d.key,level]));
    const a={id:stableId('assessment:'+student_id+':'+code),student_id,code,rubric_id:rubric.id,assessment_set:FIXTURE_BATCH,dimensions,level:assessDimensions(rubric.definition,dimensions),rationale:`SIMULATED ${scenario}; criterion levels are deterministic fixtures, not an institutional assessment.`,status:'simulated',is_synthetic:true,expires_at};
    assessments.push(a);links.push({assessment_id:a.id,evidence_id:id,student_id});
    sources.push({id:a.id,code,rubricId:rubric.id,assessmentSet:FIXTURE_BATCH,level:a.level,status:'simulated',simulated:true,evidenceValid:review_status==='accepted',conflict:review_status==='conflicting',expiresAt:expires_at});
   }
   k++;
  }
  for(const t of catalog.templates.filter(t=>t.status==='simulated')){
   const requirements=catalog.requirements.filter(r=>r.template_id===t.id).map(r=>({code:r.code,weight:r.weight,rubricId:r.rubric_id}));
   const result=evaluateRole({id:t.id,assessmentSet:t.assessment_set,minimumCoverage:70,requirements},sources,{now:new Date('2026-10-23T00:00:00Z'),simulated:true});
   snapshots.push({id:stableId('snapshot:'+student_id+':'+t.id),student_id,template_id:t.id,cohort:{fixtureBatch:FIXTURE_BATCH,family,primaryRole:role},result,is_synthetic:true});
  }
 }
 await insertRows(c,'evidence',evidence);await insertRows(c,'observations',observations);await insertRows(c,'assessments',assessments);await insertRows(c,'assessment_evidence',links);await insertRows(c,'snapshots',snapshots);
 return {students:students.length,evidence:evidence.length,observations:observations.length,assessments:assessments.length,snapshots:snapshots.length,externalRequests:0};
}
