import {runCompetency,template,recalculateStudent} from './service.js';
// Bounded durable jobs. A claim is atomic; restarts resume a failed chunk via
// explicit retry, without running large batch calculations in HTTP requests.
export function startCompetencyWorker(app,{pool,env}){
 if(env.COMPETENCY_WORKER==='off')return;
 let busy=false,stopped=false;
 async function tick(){
  if(busy||stopped)return;busy=true;
  try{
   // No elevated DB role: the actor is taken from a previously authorized job.
   // Pending actors are discovered by a narrowly-scoped security-definer helper.
   const actors=(await pool.query('SELECT * FROM competency.pending_job_actors()')).rows;
   for(const {actor_id} of actors){
    if(stopped)break;
    await processOneJob(pool,actor_id).catch(()=>{});
   }
  }catch{app.log.warn({code:'COMPETENCY_WORKER_UNAVAILABLE'},'Competency worker could not read the testing queue');}
  finally{busy=false;}
 }
 const timer=setInterval(tick,5000);timer.unref();
 app.addHook('onClose',async()=>{stopped=true;clearInterval(timer);});
}
export async function processOneJob(pool,actor){
 let jobId;
 try{return await runCompetency(pool,actor,{permission:'review'},async c=>{
  const job=(await c.query("SELECT * FROM competency.jobs WHERE created_by=$1 AND state='queued' AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",[actor])).rows[0];if(!job)return null;jobId=job.id;
  await c.query("UPDATE competency.jobs SET state='running',attempts=attempts+1 WHERE id=$1",[job.id]);
  const t=await template(c,job.template_id);
  const students=(await c.query(`SELECT id FROM competency.student_headers() WHERE ($1::text IS NULL OR source_batch=$1) AND ($2::text IS NULL OR department_short_name=$2) ORDER BY id LIMIT 20 OFFSET $3`,[job.filters.batch??null,job.filters.department??null,job.processed])).rows;
  for(const student of students)await recalculateStudent(c,student.id,t,{...job.filters,jobId:job.id});
  const done=students.length<20;
  await c.query('UPDATE competency.jobs SET state=$2,processed=processed+$3,attempts=0,finished_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1',[job.id,done?'completed':'queued',students.length,done]);
  return {id:job.id,done,processed:students.length};
 });}catch(error){
  if(jobId)await runCompetency(pool,actor,{permission:'review'},c=>c.query("UPDATE competency.jobs SET attempts=attempts+1,state=CASE WHEN attempts>=2 THEN 'failed' ELSE 'queued' END,last_error='Calculation failed. Check rubric and evidence inputs.' WHERE id=$1",[jobId])).catch(()=>{});
  throw error;
 }
}
