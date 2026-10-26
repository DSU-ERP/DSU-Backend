import {z} from 'zod';
import {createHash} from 'node:crypto';
import {competencyEnabled} from './gate.js';
import {runCompetency,catalog,profile,template,cohort,overview,invalid,notFound} from './service.js';
import {assessDimensions} from './assessment/rubrics.js';
import {validateRequirements} from './roles/engine.js';
import {Extraction,EXTRACTION_TASK,validateExtraction} from './evidence/extraction.js';
import {startCompetencyWorker} from './worker.js';
const uuid=z.string().uuid(),code=z.string().regex(/^[A-Z]+-\d{2}$/);
const text=z.string().trim().min(1).max(2000);
const filters=z.object({batch:z.string().regex(/^20\d{2}$/).optional(),department:z.string().max(100).optional()}).strict();
const evidenceInput=z.object({code:code.optional(),title:text.max(200),description:text.max(12000),contribution:text,sourceRef:text.max(500),artifactId:uuid.optional()}).strict();
const rubricDefinition=z.object({instructions:text,dimensions:z.array(z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),label:text.max(100),anchors:z.array(z.object({level:z.number().int().min(0).max(4),text})).length(5)}).strict()).min(1).max(20)}).strict();
export function registerCompetencyRoutes(api,{pool,env,generate}){
 if(!competencyEnabled(env))return;
 const run=(req,requirements,fn)=>runCompetency(pool,req.actor.id,requirements,fn);
 const read=(path,requirements,fn)=>api.get(path,async req=>({data:await run(req,requirements,(c,s)=>fn(c,s,req))}));
 const post=(path,requirements,fn)=>api.post(path,async req=>({data:await run(req,requirements,(c,s)=>fn(c,s,req))}));
 read('/competency/catalog',{},c=>catalog(c));
 read('/competency/templates/:id',{},(c,s,r)=>template(c,uuid.parse(r.params.id)));
 read('/student/career-intelligence',{},(c,s)=>{if(!s.student_id)throw notFound();return profile(c,s.student_id);});
 read('/student/career-intelligence/documents',{},async(c,s,r)=>{if(!s.student_id)throw notFound();return (await c.query('SELECT id,filename,kind FROM student.documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[r.actor.id])).rows;});
 read('/competency/artifact/:id',{},async(c,s,r)=>{const id=uuid.parse(r.params.id);const result=(await c.query('SELECT * FROM competency.artifact($1)',[id])).rows[0];if(!result)throw notFound();await c.query('INSERT INTO competency.audit(actor_id,action,resource_id) VALUES($1,\'artifact.read\',$2)',[r.actor.id,id]);return result;});
 post('/student/career-intelligence/import-platforms',{},async(c,s)=>{if(!s.student_id)throw notFound();return (await c.query('SELECT competency.import_stored_metrics() AS imported')).rows[0];});
 read('/placement/talent-intelligence',{officer:true},async(c,s)=>({...await overview(c),permissions:{review:s.review,manageRubrics:s.manage_rubrics,approveShortlist:s.approve_shortlist}}));
 read('/placement/talent-intelligence/student/:id',{officer:true},(c,s,r)=>profile(c,uuid.parse(r.params.id)));
 read('/placement/talent-intelligence/cohort',{officer:true},(c,s,r)=>cohort(c,z.object({templateId:uuid,...filters.shape,page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25),minimumCoverage:z.coerce.number().min(0).max(100).default(0),review:z.enum(['all','current','stale']).default('all')}).strict().parse(r.query)));
 post('/student/career-intelligence/evidence',{},async(c,s,r)=>{
  if(!s.student_id)throw notFound();const b=evidenceInput.parse(r.body);
  if(b.artifactId && !(await c.query('SELECT id FROM student.documents WHERE id=$1 AND user_id=$2',[b.artifactId,r.actor.id])).rows.length)throw notFound();
  if(b.code && !(await c.query('SELECT code FROM competency.catalog WHERE code=$1',[b.code])).rows.length)throw invalid('Select an existing competency.');
  const hash=createHash('sha256').update([b.title,b.description,b.contribution,b.artifactId??''].join('\n')).digest('hex');
  const created=await c.query(`INSERT INTO competency.evidence(student_id,code,source_kind,source_ref,title,description,contribution,provenance,review_status,is_synthetic,artifact_id,content_hash,created_by)
   VALUES($1,$2,'work_sample',$3,$4,$5,$6,'student_submitted','pending',false,$7,$8,$9) ON CONFLICT(student_id,source_kind,source_ref,content_hash) DO NOTHING RETURNING id`,[s.student_id,b.code??null,b.sourceRef,b.title,b.description,b.contribution,b.artifactId??null,hash,r.actor.id]);
  return {id:created.rows[0]?.id??null,duplicate:created.rows.length===0};
 });
 post('/student/career-intelligence/corrections',{},async(c,s,r)=>{
  if(!s.student_id)throw notFound();const b=z.object({evidenceId:uuid,reason:text.min(5)}).strict().parse(r.body);
  if(!(await c.query('SELECT id FROM competency.evidence WHERE id=$1 AND student_id=$2',[b.evidenceId,s.student_id])).rows.length)throw notFound();
  return (await c.query('INSERT INTO competency.review_requests(student_id,evidence_id,reason) VALUES($1,$2,$3) RETURNING id',[s.student_id,b.evidenceId,b.reason])).rows[0];
 });
 post('/placement/talent-intelligence/review',{permission:'review'},async(c,s,r)=>{
  const b=z.object({evidenceId:uuid,status:z.enum(['accepted','rejected','conflicting','unavailable']),reason:text.min(5),requestId:uuid.optional()}).strict().parse(r.body);
  const e=(await c.query('SELECT * FROM competency.evidence WHERE id=$1 FOR UPDATE',[b.evidenceId])).rows[0];if(!e)throw notFound();
  // Verification and review are distinct; accepting a claim never changes its provenance.
  await c.query('UPDATE competency.evidence SET review_status=$2 WHERE id=$1',[e.id,b.status]);
  if(b.requestId){const updated=await c.query("UPDATE competency.review_requests SET state=$3,decision=$4,reviewed_by=$5,resolved_at=now() WHERE id=$1 AND evidence_id=$2 AND state='pending' RETURNING id",[b.requestId,e.id,b.status==='accepted'?'accepted':'rejected',b.reason,r.actor.id]);if(!updated.rows.length)throw invalid('Correction request has already been resolved or belongs to another source.');}
  await c.query('INSERT INTO competency.audit(actor_id,action,resource_id,changes) VALUES($1,\'evidence.review\',$2,$3)',[r.actor.id,e.id,{before:e.review_status,after:b.status,reason:b.reason}]);
  await c.query('INSERT INTO competency.invalidations(student_id,reason) VALUES($1,$2)',[e.student_id,'Evidence review changed: '+e.id]);return {saved:true};
 });
 post('/placement/talent-intelligence/assess',{permission:'review'},async(c,s,r)=>{
  const b=z.object({studentId:uuid,rubricId:uuid,assessmentSet:text.max(100),dimensions:z.record(z.string(),z.number().int().min(0).max(4)),evidenceIds:z.array(uuid).min(1).max(20),rationale:text.min(10),supersedes:uuid.optional()}).strict().parse(r.body);
  const rubric=(await c.query("SELECT * FROM competency.rubrics WHERE id=$1 AND status='approved'",[b.rubricId])).rows[0];if(!rubric)throw invalid('An approved rubric is required.');
  const ev=(await c.query('SELECT * FROM competency.evidence WHERE id=ANY($1::uuid[]) AND student_id=$2',[b.evidenceIds,b.studentId])).rows;
  if(ev.length!==new Set(b.evidenceIds).size||ev.some(e=>e.review_status!=='accepted'||e.is_synthetic||(e.expires_at&&new Date(e.expires_at)<=new Date())))throw invalid('Assessment requires accepted, attributable, current, non-simulated evidence.');
  if(b.supersedes && !(await c.query('SELECT id FROM competency.assessments WHERE id=$1 AND student_id=$2 AND code=$3',[b.supersedes,b.studentId,rubric.code])).rows.length)throw invalid('The superseded assessment must belong to this student and competency.');
  let level;try{level=assessDimensions(rubric.definition,b.dimensions);}catch(e){throw invalid(e.message);}
  const a=(await c.query(`INSERT INTO competency.assessments(student_id,code,rubric_id,assessment_set,dimensions,level,rationale,status,is_synthetic,reviewed_by,supersedes) VALUES($1,$2,$3,$4,$5,$6,$7,'reviewed',false,$8,$9) RETURNING id`,[b.studentId,rubric.code,b.rubricId,b.assessmentSet,b.dimensions,level,b.rationale,r.actor.id,b.supersedes??null])).rows[0];
  for(const e of ev)await c.query('INSERT INTO competency.assessment_evidence(assessment_id,evidence_id,student_id) VALUES($1,$2,$3)',[a.id,e.id,b.studentId]);
  await c.query('INSERT INTO competency.invalidations(student_id,reason) VALUES($1,$2)',[b.studentId,'New reviewed assessment: '+a.id]);return {...a,level};
 });
 post('/placement/talent-intelligence/rubrics',{permission:'manage_rubrics'},async(c,s,r)=>{
  const b=z.object({code,definition:rubricDefinition,status:z.enum(['draft','approved']),reason:text.min(10)}).strict().parse(r.body);
  for(const d of b.definition.dimensions)if(new Set(d.anchors.map(a=>a.level)).size!==5)throw invalid('Each criterion requires all five distinct level anchors.');
  if(new Set(b.definition.dimensions.map(d=>d.key)).size!==b.definition.dimensions.length)throw invalid('Criterion keys must be unique.');
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",['competency.rubric.'+b.code]);
  const version=(await c.query('SELECT coalesce(max(version),0)+1 v FROM competency.rubrics WHERE code=$1',[b.code])).rows[0].v;
  return (await c.query('INSERT INTO competency.rubrics(code,version,definition,status,approved_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[b.code,version,{...b.definition,approvalReason:b.reason},b.status,b.status==='approved'?r.actor.id:null])).rows[0];
 });
 post('/placement/talent-intelligence/templates',{permission:'manage_rubrics'},async(c,s,r)=>{
  const b=z.object({roleId:text.max(100),status:z.enum(['draft','approved']),assessmentSet:text.max(100),minimumCoverage:z.number().min(0).max(100),requirements:z.array(z.object({code,rubricId:uuid,weight:z.number().positive().max(100)}).strict()).min(1).max(148),reason:text.min(10)}).strict().parse(r.body);
  try{validateRequirements(b.requirements);}catch(e){throw invalid(e.message);}
  const chosen=(await c.query('SELECT id,code,status FROM competency.rubrics WHERE id=ANY($1::uuid[])',[b.requirements.map(q=>q.rubricId)])).rows;
  if(b.requirements.some(q=>!chosen.some(r=>r.id===q.rubricId&&r.code===q.code&&(b.status!=='approved'||r.status==='approved'))))throw invalid('Each requirement needs its matching rubric; approving a role requires all rubrics to be approved first.');
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",['competency.template.'+b.roleId]);
  const v=(await c.query('SELECT coalesce(max(version),0)+1 v FROM competency.templates WHERE role_id=$1',[b.roleId])).rows[0].v;
  const t=(await c.query('INSERT INTO competency.templates(role_id,version,status,assessment_set,minimum_coverage,approved_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[b.roleId,v,b.status,b.assessmentSet,b.minimumCoverage,b.status==='approved'?r.actor.id:null])).rows[0];
  for(const q of b.requirements)await c.query('INSERT INTO competency.requirements(template_id,code,rubric_id,weight) VALUES($1,$2,$3,$4)',[t.id,q.code,q.rubricId,q.weight]);
  await c.query('INSERT INTO competency.audit(actor_id,action,resource_id,changes) VALUES($1,\'template.version\',$2,$3)',[r.actor.id,t.id,{reason:b.reason,version:v}]);return t;
 });
 post('/placement/talent-intelligence/recalculate',{permission:'review'},async(c,s,r)=>{
  const b=z.object({templateId:uuid,filters}).strict().parse(r.body),t=await template(c,b.templateId);
  if(t.status==='draft')throw invalid('Approve a role template before operational calculation.');
  return (await c.query('INSERT INTO competency.jobs(template_id,filters,created_by) VALUES($1,$2,$3) RETURNING id,state',[b.templateId,b.filters,r.actor.id])).rows[0];
 });
 post('/placement/talent-intelligence/shortlists',{permission:'review'},async(c,s,r)=>{
  const b=z.object({snapshotId:uuid,reason:text.min(10)}).strict().parse(r.body);
  const snap=(await c.query(`SELECT s.* FROM competency.snapshots s WHERE id=$1 AND NOT is_synthetic AND NOT EXISTS(SELECT 1 FROM competency.invalidations i WHERE i.student_id=s.student_id AND i.created_at>s.created_at)`,[b.snapshotId])).rows[0];
  if(!snap||!Number.isFinite(snap.result.alignment)||snap.result.coverage<=0||snap.result.coverage<snap.result.minimumCoverage)throw invalid('A current, sufficiently assessed, non-simulated snapshot is required.');
  return (await c.query('INSERT INTO competency.shortlists(snapshot_id,reason,created_by) VALUES($1,$2,$3) RETURNING id',[b.snapshotId,b.reason,r.actor.id])).rows[0];
 });
 post('/placement/talent-intelligence/shortlists/decision',{permission:'approve_shortlist'},async(c,s,r)=>{
  const b=z.object({id:uuid,decision:z.enum(['approved','rejected'])}).strict().parse(r.body);
  const item=(await c.query(`SELECT l.*,s.is_synthetic,s.student_id,s.created_at snapshot_time,s.result FROM competency.shortlists l JOIN competency.snapshots s ON s.id=l.snapshot_id WHERE l.id=$1 FOR UPDATE OF l`,[b.id])).rows[0];
  if(!item||item.state!=='proposed'||item.created_by===r.actor.id)throw invalid('A different authorized reviewer must decide a pending shortlist.');
  if(item.is_synthetic||(await c.query('SELECT 1 FROM competency.invalidations WHERE student_id=$1 AND created_at>$2 LIMIT 1',[item.student_id,item.snapshot_time])).rows.length)throw invalid('Simulated or stale results cannot be approved.');
  await c.query('UPDATE competency.shortlists SET state=$2,approved_by=$3 WHERE id=$1',[b.id,b.decision,r.actor.id]);return {saved:true};
 });
 // AI calls occur outside transactions. Only authorized, bounded evidence is sent.
 api.post('/competency/extract',async req=>{
  const b=z.object({evidenceIds:z.array(uuid).min(1).max(10)}).strict().parse(req.body);
  const prepared=await run(req,{},async(c,s)=>{
   const evidence=(await c.query('SELECT id,student_id,source_ref,description FROM competency.evidence WHERE id=ANY($1::uuid[])',[b.evidenceIds])).rows;
   if(evidence.length!==new Set(b.evidenceIds).size||new Set(evidence.map(e=>e.student_id)).size!==1)throw notFound();
   return {officer:s.officer,evidence,codes:(await c.query('SELECT code FROM competency.catalog')).rows.map(r=>r.code)};
  });
  const source=prepared.evidence.map(e=>({id:e.id,source_ref:e.source_ref,description:e.description.slice(0,8000)}));
  const output=await generate(req.actor.id,'competency.extract',EXTRACTION_TASK,{evidence:source,competencyCodes:prepared.codes},Extraction,{officer:prepared.officer});
  let validated;try{validated=validateExtraction(output,source,prepared.codes);}catch{throw invalid('AI evidence references could not be verified. No assessment was saved.');}
  return {data:await run(req,{},async(c)=>{
   const current=(await c.query('SELECT id FROM competency.evidence WHERE id=ANY($1::uuid[])',[b.evidenceIds])).rows;if(current.length!==source.length)throw notFound();
   return (await c.query('INSERT INTO competency.extractions(student_id,content,created_by) VALUES($1,$2,$3) RETURNING id,content',[prepared.evidence[0].student_id,validated,req.actor.id])).rows[0];
  })};
 });
 // /v1 and /api/v1 each register routes; only the public mount owns the worker.
 if(api.prefix==='/api/v1')startCompetencyWorker(api,{pool,env});
}
