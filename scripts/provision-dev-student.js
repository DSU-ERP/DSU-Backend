// Creates the synthetic development student (student@gmail.com, DEVSTUDENT0001)
// in an ISOLATED development Supabase project only. Dry run unless --apply.
// It reads only the explicitly exported DEV_* variables for the target. The
// runtime .env and .env.operator files are parsed solely to learn which
// projects and hosts must never be touched; they are never connected to.
//
//   DSU_ENVIRONMENT=development DEV_SUPABASE_URL=... DEV_DATABASE_ADMIN_URL=... \
//   DEV_SUPABASE_SERVICE_ROLE_KEY=... npm run dev:provision-student -- --apply
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { createPool } from "../src/integrations/supabase/db.js";
import { databaseChecks, provisionInTransaction, staticChecks } from "../src/platform/devguard.js";

const EMAIL = "student@gmail.com";
const ENROLLMENT = "DEVSTUDENT0001";

function knownProtectedValues() {
  const known = {};
  for (const file of [".env", ".env.operator"]) {
    if (!existsSync(file)) continue;
    const parsed = parseEnv(readFileSync(file, "utf8"));
    for (const name of ["SUPABASE_URL", "DATABASE_URL", "DATABASE_ADMIN_URL"]) if (parsed[name]) known[name] ??= parsed[name];
  }
  for (const name of ["SUPABASE_URL", "DATABASE_URL", "DATABASE_ADMIN_URL"]) if (process.env[name]) known[name] ??= process.env[name];
  return known;
}

const refuse = (reasons) => {
  console.error(JSON.stringify({ event: "dev_provision_refused", reasons }));
  process.exit(1);
};

const env = process.env;
const checks = staticChecks(env, process.argv.slice(2), knownProtectedValues());
if (!checks.ok) refuse(checks.reasons);

const pool = createPool(env.DEV_DATABASE_ADMIN_URL, { ...env, DATABASE_POOL_MAX: 1 });
let client;
try {
  client = await pool.connect();
  const db = await databaseChecks((sql, values) => client.query(sql, values));
  if (!db.ok) refuse(db.reasons);
  if (!checks.apply) {
    console.log(JSON.stringify({ event: "dev_provision_dry_run", email: EMAIL, enrollment: ENROLLMENT, action: "Re-run with --apply to create the account." }));
    process.exit(0);
  }
  const target = new URL(env.DEV_SUPABASE_URL).origin;
  const adminHeaders = {
    apikey: env.DEV_SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.DEV_SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
  const createUser = async () => {
    const response = await fetch(`${target}/auth/v1/admin/users`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: adminHeaders,
      body: JSON.stringify({ email: EMAIL, password: env.DEV_STUDENT_PASSWORD || "student", email_confirm: true }),
    });
    const user = await response.json().catch(() => ({}));
    if (!response.ok || typeof user.id !== "string")
      throw Object.assign(new Error("Supabase Admin API did not create the user"), { code: "AUTH_USER_NOT_CREATED", status: response.status });
    return user;
  };
  // Removes the Auth user again when the database transaction fails (no orphans).
  const deleteUser = async (id) => {
    const response = await fetch(`${target}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: adminHeaders,
    });
    if (!response.ok) console.error(JSON.stringify({ event: "dev_provision_cleanup_failed", status: response.status }));
  };
  const studentId = randomUUID();
  await provisionInTransaction(client, {
    createUser,
    deleteUser,
    async insertStudent(c) {
      await c.query(
        `INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,course_name,department_name,department_short_name,current_semester)
         VALUES($1,$2,'Development Student','2027','synthetic','B.Tech','Computer Science and Engineering','CSE','7')`,
        [studentId, ENROLLMENT],
      );
      await c.query("INSERT INTO erp.academics(student_id,cgpa,sgpa,attendance,current_backlog) VALUES($1,8.25,8.4,90,0)", [studentId]);
      await c.query("INSERT INTO erp.contacts(student_id,details) VALUES($1,$2::jsonb)", [studentId, JSON.stringify({ email: EMAIL })]);
    },
    async insertMembership(c, userId) {
      // Student role only; this script never grants officer or admin access.
      await c.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [userId, studentId]);
      await c.query("INSERT INTO erp.audit_events(action,resource_id) VALUES('dev.provision_student',$1)", [ENROLLMENT]);
    },
  });
  console.log(JSON.stringify({ event: "dev_provision_applied", email: EMAIL, enrollment: ENROLLMENT }));
} catch (error) {
  // provisionInTransaction already rolled back and removed any Auth user it created.
  console.error(JSON.stringify({ event: "dev_provision_failed", code: error.code || "DEV_PROVISION_FAILED", status: error.status }));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
