import { withActor } from "../../integrations/supabase/db.js";
import { httpError } from "../../platform/http/errors.js";

import { ttlCache, identityCacheMs } from "../../platform/cache/ttl.js";

const CONTEXT_SQL = (actor) => `SELECT s.id,s.enrollment_no,s.full_name,s.course_name,s.department_name,s.department_short_name,
    s.current_semester,s.source_batch,a.cgpa::text,a.attendance::text,a.current_backlog,a.sgpa::text
    FROM erp.memberships m JOIN erp.students s ON s.id=m.student_id LEFT JOIN erp.academics a ON a.student_id=s.id
    WHERE m.user_id=${actor} AND m.role='student'`;

// The linked official record changes only through officer imports or access
// grants. Caching it per user (IDENTITY_CACHE_MS) removes a cross-region round
// trip from every student request; imports clear it (see clearStudentContexts).
const contexts = ttlCache({ ttlMs: identityCacheMs });
export const forgetStudentContext = (actor) => contexts.delete(actor);
export const clearStudentContexts = () => contexts.clear();

const required = (row) => {
  if (!row)
    throw httpError(
      403,
      "STUDENT_ACCESS_REQUIRED",
      "Your administrator needs to link your student account.",
    );
  return row;
};

export async function studentContext(client, actor) {
  const { rows } = await client.query(CONTEXT_SQL("$1"), [actor]);
  return contexts.set(actor, required(rows[0]));
}

/**
 * Runs fn(client, student) in the actor's transaction. A cached context skips
 * the lookup; otherwise it rides in the same round trip as BEGIN (prelude).
 */
export function runStudent(pool, actor, fn) {
  const cached = contexts.get(actor);
  if (cached) return withActor(pool, actor, (client) => fn(client, cached));
  return withActor(
    pool,
    actor,
    (client, rows) => fn(client, contexts.set(actor, required(rows[0]))),
    { prelude: (literal) => CONTEXT_SQL(literal(actor)) },
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
