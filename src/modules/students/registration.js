import {z} from 'zod';
import {withActor} from '../../integrations/supabase/db.js';
import {httpError,databaseError} from '../../platform/http/errors.js';
import {profileSchema} from './profile.js';
const academicSchema=z.object({
  enrollmentNo:z.string().trim().max(80).default(''),
  yearOfStudy:z.string().trim().max(40).default(''),
  cgpa:z.string().trim().refine(v=>v===''||/^(?:[0-9](?:\.\d{1,3})?|10(?:\.0{1,3})?)$/.test(v)).default(''),
}).strict();
async function context(client){
  try{
    const {rows}=await client.query('SELECT student.registration_context() AS data');
    return rows[0].data;
  }catch(error){throw databaseError(error);}
}
export function registerRegistrationRoutes(api,{pool}){
  api.get('/onboarding',async req=>withActor(pool,req.actor.id,async client=>{
    const identity=await context(client);
    if(['officer','restricted','verify_email'].includes(identity.state))return {data:{...identity,draft:null,profile:null}};
    const draft=(await client.query('SELECT details,academic,step,status,revision FROM student.registration_drafts WHERE user_id=$1',[req.actor.id])).rows[0]||null;
    const profile=(await client.query('SELECT details,onboarded FROM student.profiles WHERE user_id=$1',[req.actor.id])).rows[0]||null;
    return {data:{...identity,draft,profile}};
  }));
  api.post('/onboarding', {bodyLimit:20000},async req=>{
    const input=z.object({details:profileSchema,academic:academicSchema,step:z.number().int().min(0).max(4),revision:z.number().int().nonnegative(),complete:z.boolean().default(false),consent:z.boolean().default(false)}).strict().parse(req.body);
    return withActor(pool,req.actor.id,async client=>{
      const identity=await context(client);
      if(['officer','restricted','verify_email'].includes(identity.state))throw httpError(403,'ONBOARDING_NOT_ALLOWED','Verify your student email before completing onboarding.');
      if(input.complete&&(!input.consent||!input.details.interests.length||!input.details.dreamRoles.trim()||
        (!identity.official&&(!input.academic.enrollmentNo||!input.details.department||!input.details.program))))
        throw httpError(400,'INCOMPLETE_PROFILE','Complete your academic details, interests, career goals and confirmation.');
      const details={...input.details};
      // Personal aspirations stay editable; official academics are never written here.
      if(identity.official)Object.assign(details,{fullName:identity.official.full_name,department:identity.official.department_name||'',program:identity.official.course_name||'',semester:identity.official.current_semester||'',graduationYear:identity.official.source_batch});
      const academic=identity.official?{enrollmentNo:identity.official.enrollment_no,yearOfStudy:input.academic.yearOfStudy,cgpa:identity.official.cgpa||''}:input.academic;
      const {rows}=await client.query(`INSERT INTO student.registration_drafts(user_id,details,academic,step)
        SELECT $1,$2,$3,$4 WHERE $5=0 OR EXISTS(SELECT 1 FROM student.registration_drafts WHERE user_id=$1)
        ON CONFLICT(user_id) DO UPDATE SET details=EXCLUDED.details,academic=EXCLUDED.academic,step=EXCLUDED.step,
        revision=student.registration_drafts.revision+1,updated_at=now() WHERE student.registration_drafts.revision=$5
        RETURNING revision`,[req.actor.id,JSON.stringify(details),JSON.stringify(academic),input.step,input.revision]);
      if(!rows[0])throw httpError(409,'PROFILE_CHANGED','Your onboarding changed in another tab. Reload before saving.');
      let status='draft';
      if(input.complete){
        let linked;
        try{
          if(identity.official)linked=(await client.query('SELECT student.link_registration() AS linked')).rows[0].linked;
          else{
            // No email match: link straight to the record for the USN the student entered.
            linked=(await client.query('SELECT student.link_by_enrollment($1) AS linked',[input.academic.enrollmentNo])).rows[0].linked;
            if(!linked)throw httpError(409,'USN_UNAVAILABLE','No available university record was found for this USN. Check the USN you entered; if it is correct, it may already be linked to another account, so contact the placement office.');
            const refreshed=await context(client);
            if(refreshed.official)Object.assign(details,{fullName:refreshed.official.full_name,department:refreshed.official.department_name||'',program:refreshed.official.course_name||'',semester:refreshed.official.current_semester||'',graduationYear:refreshed.official.source_batch});
          }
        }
        catch(error){if(error.statusCode)throw error;if(error.code==='23505')throw httpError(409,'USN_UNAVAILABLE','This university record is already linked to another account. Contact the placement office.');throw databaseError(error);}
        status=linked?'completed':'pending';
        if(linked)await client.query(`INSERT INTO student.profiles(user_id,details,onboarded) VALUES($1,$2,true)
          ON CONFLICT(user_id) DO UPDATE SET details=EXCLUDED.details,onboarded=true,revision=student.profiles.revision+1,updated_at=now()`,[req.actor.id,JSON.stringify(details)]);
      }
      await client.query('UPDATE student.registration_drafts SET status=$2 WHERE user_id=$1',[req.actor.id,status]);
      return {data:{revision:rows[0].revision,status,home:status==='completed'?'/student/dashboard':null}};
    });
  });
}
