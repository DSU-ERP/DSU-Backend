import { z } from "zod";
import { createPool } from "../src/integrations/supabase/db.js";
const [userId, role, enrollment] = process.argv.slice(2);
if (
  !z.uuid().safeParse(userId).success ||
  !["admin", "staff", "student"].includes(role) ||
  (role === "student" && !enrollment)
) {
  console.error(
    "Usage: npm run access:grant -- <existing-auth-user-uuid> <admin|staff|student> [enrollment-number]",
  );
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_ADMIN_URL);
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  let studentId = null;
  if (role === "student") {
    studentId = (
      await client.query("SELECT id FROM erp.students WHERE enrollment_no=$1", [
        enrollment.trim().toUpperCase(),
      ])
    ).rows[0]?.id;
    if (!studentId) throw new Error("Unknown enrollment");
  }
  await client.query(
    "INSERT INTO erp.memberships(user_id,role,student_id) VALUES ($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,student_id=EXCLUDED.student_id",
    [userId, role, studentId],
  );
  await client.query(
    "INSERT INTO erp.audit_events(action,resource_id) VALUES ($1,$2)",
    [`membership.grant.${role}`, userId],
  );
  await client.query("COMMIT");
  console.log("Account access assigned.");
} catch (e) {
  if (client) await client.query("ROLLBACK");
  console.error(
    "Access assignment failed. Check the existing Auth user, enrollment, and unique student link.",
    e.code || "INVALID_LINK",
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
