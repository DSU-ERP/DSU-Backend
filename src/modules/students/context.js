import { withActor } from "../../integrations/supabase/db.js";
import { httpError } from "../../platform/http/errors.js";

export async function studentContext(client, actor) {
  const { rows } = await client.query(
    `SELECT s.id,s.enrollment_no,s.full_name,s.course_name,s.department_name,s.department_short_name,
    s.current_semester,s.source_batch,a.cgpa::text,a.attendance::text,a.current_backlog,a.sgpa::text
    FROM erp.memberships m JOIN erp.students s ON s.id=m.student_id LEFT JOIN erp.academics a ON a.student_id=s.id
    WHERE m.user_id=$1 AND m.role='student'`,
    [actor],
  );
  if (!rows[0])
    throw httpError(
      403,
      "STUDENT_ACCESS_REQUIRED",
      "Your administrator needs to link your student account.",
    );
  return rows[0];
}
export function runStudent(pool, actor, fn) {
  return withActor(pool, actor, async (client) =>
    fn(client, await studentContext(client, actor)),
  );
}
export async function owned(client, table, id, actor, lock = false) {
  const tables = [
    "interviews",
    "interview_sessions",
    "conversations",
    "attempts",
    "documents",
    "reports",
  ];
  if (!tables.includes(table)) throw new Error("Invalid resource table");
  const { rows } = await client.query(
    `SELECT * FROM student.${table} WHERE id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`,
    [id, actor],
  );
  if (!rows[0])
    throw httpError(404, "NOT_FOUND", "This record is unavailable.");
  return rows[0];
}
export async function activity(client, actor, kind, id = null) {
  await client.query(
    "INSERT INTO student.activity(user_id,kind,resource_id) VALUES($1,$2,$3)",
    [actor, kind, id],
  );
}
