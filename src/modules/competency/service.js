import {withActor} from '../../integrations/supabase/db.js';
import {httpError} from '../../platform/http/errors.js';
import {evaluateRole,rankComparable} from './roles/engine.js';
export const denied=()=>httpError(403,'COMPETENCY_FORBIDDEN','You do not have permission for this competency action.');
export const invalid=message=>httpError(400,'COMPETENCY_INVALID',message);
export const notFound=()=>httpError(404,'NOT_FOUND','This competency record is unavailable.');
export async function scope(c,{officer=false,permission}={}){
 const row=(await c.query("SELECT competency.marker_valid() marker,erp.actor_student() student_id,student.is_officer() officer,competency.can('review') review,competency.can('manage_rubrics') manage_rubrics,competency.can('approve_shortlist') approve_shortlist")).rows[0];
 if(!row.marker || (!row.student_id&&!row.officer) || (officer&&!row.officer) || (permission&&!row[permission]))throw denied();
 return row;
}
export function runCompetency(pool,actor,requirements,fn){return withActor(pool,actor,async c=>fn(c,await scope(c,requirements)),{repeatableRead:true});}
export async function auditRead(c,action,resource){await c.query('INSERT INTO competency.audit(actor_id,action,resource_id) VALUES(erp.actor_id(),$1,$2)',[action,resource]);}
export async function catalog(c){
 const competencies=(await c.query('SELECT * FROM competency.catalog ORDER BY code')).rows;
 const roles=(await c.query(`SELECT r.*,coalesce(jsonb_agg(jsonb_build_object('id',t.id,'version',t.version,'status',t.status,'minimumCoverage',t.minimum_coverage,'assessmentSet',t.assessment_set) ORDER BY t.version DESC) FILTER(WHERE t.id IS NOT NULL),'[]') templates FROM competency.roles r LEFT JOIN competency.templates t ON t.role_id=r.id GROUP BY r.id ORDER BY r.family,r.name`)).rows;
 return {competencies,roles};
}
export async function template(c,id){
 const t=(await c.query('SELECT t.*,r.name FROM competency.templates t JOIN competency.roles r ON r.id=t.role_id WHERE t.id=$1',[id])).rows[0];
 if(!t)throw notFound();
 const req=(await c.query(`SELECT q.*,c.name,r.definition,r.status AS rubric_status FROM competency.requirements q JOIN competency.catalog c ON c.code=q.code JOIN competency.rubrics r ON r.id=q.rubric_id WHERE template_id=$1 ORDER BY q.code`,[id])).rows;
 return {...t,assessmentSet:t.assessment_set,minimumCoverage:Number(t.minimum_coverage),requirements:req.map(r=>({...r,weight:Number(r.weight),rubricId:r.rubric_id}))};
}
export async function assessments(c,studentId){
 return (await c.query(`SELECT a.*,NOT EXISTS(SELECT 1 FROM competency.assessments newer WHERE newer.supersedes=a.id) AS current,
 competency.assessment_visible(a.id) AND EXISTS(SELECT 1 FROM competency.assessment_evidence l WHERE l.assessment_id=a.id) AND NOT EXISTS(
 SELECT 1 FROM competency.assessment_evidence l JOIN competency.evidence e ON e.id=l.evidence_id WHERE l.assessment_id=a.id AND
 (e.review_status<>'accepted' OR (e.expires_at IS NOT NULL AND e.expires_at<=now()) OR e.is_synthetic<>a.is_synthetic)) AS evidence_valid,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'title',e.title,'sourceRef',e.source_ref,'provenance',e.provenance,'reviewStatus',e.review_status)),'[]') FROM competency.assessment_evidence l JOIN competency.evidence e ON e.id=l.evidence_id WHERE l.assessment_id=a.id) AS sources
 FROM competency.assessments a WHERE student_id=$1 ORDER BY a.created_at DESC,a.id`,[studentId])).rows.map(a=>({...a,level:Number(a.level),rubricId:a.rubric_id,assessmentSet:a.assessment_set,simulated:a.is_synthetic,evidenceValid:a.evidence_valid,expiresAt:a.expires_at}));
}
export async function profile(c,studentId){
 const identity=(await c.query('SELECT * FROM competency.student_headers() WHERE id=$1',[studentId])).rows[0];if(!identity)throw notFound();
 await auditRead(c,'profile.read',studentId);
 const assessed=await assessments(c,studentId);
 const evidence=(await c.query('SELECT id,code,source_kind,source_ref,title,description,contribution,provenance,review_status,is_synthetic,artifact_id,observed_at,expires_at,created_at FROM competency.evidence WHERE student_id=$1 ORDER BY created_at DESC,id LIMIT 300',[studentId])).rows;
 const requests=(await c.query('SELECT * FROM competency.review_requests WHERE student_id=$1 ORDER BY created_at DESC LIMIT 100',[studentId])).rows;
 const snapshots=(await c.query(`SELECT DISTINCT ON(s.template_id) s.*,r.name AS role_name,
 EXISTS(SELECT 1 FROM competency.invalidations i WHERE i.student_id=s.student_id AND i.created_at>s.created_at) AS stale,
 EXISTS(SELECT 1 FROM jsonb_array_elements(s.result->'inputs') x WHERE x->>'assessmentId' IS NOT NULL AND NOT competency.assessment_visible((x->>'assessmentId')::uuid)) AS withheld
 FROM competency.snapshots s JOIN competency.templates t ON t.id=s.template_id JOIN competency.roles r ON r.id=t.role_id WHERE s.student_id=$1 ORDER BY s.template_id,s.created_at DESC,s.id DESC`,[studentId])).rows;
 const roles=snapshots.map(s=>({...s,result:s.withheld?{...s.result,alignment:null,coverage:0,inputs:[],gaps:[],state:'Evidence unavailable'}:s.result,stale:s.withheld||s.stale||s.result.inputs.some(x=>x.assessmentId&&!assessed.some(a=>a.id===x.assessmentId&&a.current&&a.evidenceValid&&(!a.expiresAt||new Date(a.expiresAt)>new Date())))}));
 const all=(await c.query('SELECT * FROM competency.catalog ORDER BY family,code')).rows;
 const competencies=all.map(comp=>({...comp,assessments:assessed.filter(a=>a.code===comp.code&&a.current)}));
 return {identity,competencies,evidence,requests,roles,notice:'Pilot testing data. Simulated assessments are not verified credentials or hiring recommendations.'};
}
export async function cohort(c,{templateId,batch,department,page=1,pageSize=25,minimumCoverage=0,review='all'}){
 const t=await template(c,templateId);
 const students=(await c.query(`SELECT * FROM competency.student_headers() WHERE ($1::text IS NULL OR source_batch=$1) AND ($2::text IS NULL OR department_short_name=$2) ORDER BY id LIMIT 10001`,[batch??null,department??null])).rows;
 if(students.length>10000)throw invalid('Narrow the cohort before comparing students.');
 const ids=students.map(s=>s.id);
 const latest=(await c.query(`SELECT DISTINCT ON(s.student_id) s.*,
 EXISTS(SELECT 1 FROM jsonb_array_elements(s.result->'inputs') x WHERE x->>'assessmentId' IS NOT NULL AND NOT competency.assessment_visible((x->>'assessmentId')::uuid)) AS withheld,
 EXISTS(SELECT 1 FROM competency.invalidations i WHERE i.student_id=s.student_id AND i.created_at>s.created_at) OR EXISTS(
 SELECT 1 FROM jsonb_array_elements(s.result->'inputs') x JOIN competency.assessments a ON a.id=(x->>'assessmentId')::uuid
 JOIN competency.assessment_evidence l ON l.assessment_id=a.id JOIN competency.evidence e ON e.id=l.evidence_id
 WHERE (e.expires_at IS NOT NULL AND e.expires_at<=now()) OR e.review_status<>'accepted' OR (a.expires_at IS NOT NULL AND a.expires_at<=now())) AS stale
 FROM competency.snapshots s WHERE s.template_id=$1 AND s.student_id=ANY($2::uuid[]) ORDER BY s.student_id,s.created_at DESC,s.id DESC`,[templateId,ids])).rows;
 const rows=students.map(student=>{const snap=latest.find(s=>s.student_id===student.id);return {studentId:student.id,student,snapshotId:snap?.id??null,result:snap&&!snap.withheld?snap.result:evaluateRole(t,[],{simulated:t.status==='simulated'}),stale:snap?.withheld||snap?.stale||false};});
 // Coverage and review state explicitly define the comparison cohort. Only
 // pagination hides ranked rows; it must never change a student's rank.
 const filtered=rankComparable(rows.filter(r=>r.result.coverage>=minimumCoverage && (review==='all'||(review==='current'&&!r.stale)||(review==='stale'&&r.stale))));
 await auditRead(c,'cohort.read',templateId);
 return {template:t,total:filtered.length,cohortTotal:students.length,page,pageSize,rows:filtered.slice((page-1)*pageSize,page*pageSize),limitations:'Rank requires identical role version, assessment set, assessed competencies and rubric versions. Simulation cannot be used for a real shortlist.'};
}
export async function overview(c){
 const counts=(await c.query(`SELECT (SELECT count(*)::int FROM competency.student_headers()) students,(SELECT count(*)::int FROM competency.evidence) evidence,(SELECT count(*)::int FROM competency.evidence WHERE review_status='pending') pending,(SELECT count(*)::int FROM competency.assessments WHERE status='reviewed') reviewed,(SELECT count(*)::int FROM competency.assessments WHERE status='simulated') simulated`)).rows[0];
 const statuses=(await c.query('SELECT review_status,count(*)::int count FROM competency.evidence GROUP BY review_status ORDER BY review_status')).rows;
 const reviewQueue=(await c.query('SELECT id,student_id,code,title,provenance,review_status FROM competency.evidence WHERE review_status IN(\'pending\',\'conflicting\') ORDER BY created_at LIMIT 50')).rows;
 const requests=(await c.query("SELECT * FROM competency.review_requests WHERE state='pending' ORDER BY created_at LIMIT 50")).rows;
 const shortlists=(await c.query('SELECT * FROM competency.shortlists ORDER BY created_at DESC LIMIT 100')).rows;
 const jobs=(await c.query('SELECT * FROM competency.jobs ORDER BY created_at DESC LIMIT 20')).rows;
 return {counts,statuses,reviewQueue,requests,shortlists,jobs};
}
export async function recalculateStudent(c,studentId,t,cohortDefinition){
 if(!['approved','simulated'].includes(t.status))throw invalid('Draft role templates cannot produce role results.');
 const input=(await assessments(c,studentId)).filter(a=>a.current);
 const result=evaluateRole(t,input,{simulated:t.status==='simulated'});
 return (await c.query('INSERT INTO competency.snapshots(student_id,template_id,cohort,result,is_synthetic) VALUES($1,$2,$3,$4,$5) RETURNING id',[studentId,t.id,cohortDefinition,result,t.status==='simulated'])).rows[0];
}
