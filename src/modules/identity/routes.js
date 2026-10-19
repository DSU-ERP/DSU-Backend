import { withActor } from '../../integrations/supabase/db.js';

// The authenticated account's database assignments determine its workspace.
// Portal query parameters and user-editable Auth metadata never grant access.
export function registerIdentityRoutes(api, {pool}) {
  api.get('/session', async req => withActor(pool,req.actor.id,async client=>{
    const {rows}=await client.query(`SELECT student.is_officer() AS officer,
      EXISTS(SELECT 1 FROM erp.memberships m JOIN erp.students s ON s.id=m.student_id
        WHERE m.user_id=$1 AND m.role='student') AS student,
      EXISTS(SELECT 1 FROM erp.memberships WHERE user_id=$1) AS assigned`,[req.actor.id]);
    const role=rows[0].officer ? 'placement_officer' : rows[0].student ? 'student' : null;
    return {data:{role,home:role==='placement_officer'?'/placement':role==='student'?'/student':rows[0].assigned?'/access':'/onboarding'}};
  }));
}
