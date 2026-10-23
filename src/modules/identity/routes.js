import { withActor } from '../../integrations/supabase/db.js';
import { onboardingRequired } from '../intelligence/student-routes.js';

// The authenticated account's database assignments determine its workspace.
// Portal query parameters and user-editable Auth metadata never grant access.
// A linked student whose skills onboarding is behind the current version is
// sent to /student/onboarding first (docs/STUDENT-INTELLIGENCE.md section 4).
export function registerIdentityRoutes(api, {pool}) {
  api.get('/session', async req => withActor(pool,req.actor.id,async client=>{
    const {rows}=await client.query(`SELECT student.is_officer() AS officer,
      (SELECT s.id FROM erp.memberships m JOIN erp.students s ON s.id=m.student_id
        WHERE m.user_id=$1 AND m.role='student') AS student,
      EXISTS(SELECT 1 FROM erp.memberships WHERE user_id=$1) AS assigned`,[req.actor.id]);
    const role=rows[0].officer ? 'placement_officer' : rows[0].student ? 'student' : null;
    const required=role==='student' && await onboardingRequired(client,rows[0].student);
    const home=role==='placement_officer'?'/placement':role==='student'?(required?'/student/onboarding':'/student'):rows[0].assigned?'/access':'/onboarding';
    return {data:{role,home,onboardingRequired:required}};
  }));
}
