// Integration verification against PostgreSQL. Every synthetic row is rolled back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../src/integrations/supabase/db.js";
import { HEADERS, normalizeStudent } from "../src/modules/imports/csv.js";
import { upsertBatch } from "../src/modules/imports/importer.js";
const pool = createPool(process.env.DATABASE_ADMIN_URL);
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  const ids = {
    admin: randomUUID(),
    staff: randomUUID(),
    student: randomUUID(),
    unlinked: randomUUID(),
  };
  for (const id of Object.values(ids))
    await client.query(
      "INSERT INTO auth.users(id,aud,role,email) VALUES ($1,$2,$3,$4)",
      [id, "authenticated", "authenticated", `test-${id}@example.invalid`],
    );
  const raw = Object.fromEntries(HEADERS.map((h) => [h, ""]));
  Object.assign(raw, {
    enrollmentNo: `TEST-${randomUUID()}`,
    studentFullName: "Synthetic verification record",
    cgpa: "8.4",
    feesOutstandingAmount: "-10",
  });
  const first = normalizeStudent(raw, "2099");
  assert.deepEqual(await upsertBatch(client, [first]), {
    inserted: 1,
    updated: 0,
    unchanged: 0,
  });
  assert.deepEqual(await upsertBatch(client, [first]), {
    inserted: 0,
    updated: 0,
    unchanged: 1,
  });
  const updated = normalizeStudent({ ...raw, cgpa: "8.5" }, "2099");
  assert.deepEqual(await upsertBatch(client, [updated]), {
    inserted: 0,
    updated: 1,
    unchanged: 0,
  });
  const student = (
    await client.query("SELECT id FROM erp.students WHERE enrollment_no=$1", [
      first.enrollment_no,
    ])
  ).rows[0].id;
  for (const role of ["admin", "staff", "student"])
    await client.query(
      "INSERT INTO erp.memberships(user_id,role,student_id) VALUES ($1,$2,$3)",
      [ids[role], role, role === "student" ? student : null],
    );
  async function become(role) {
    await client.query("RESET ROLE");
    await client.query("SELECT set_config('app.user_id',$1,true)", [
      ids[role] || "",
    ]);
    await client.query("SET LOCAL ROLE dsu_api");
  }
  async function denied(sql, params = []) {
    await client.query("SAVEPOINT denied_check");
    await assert.rejects(client.query(sql, params));
    await client.query("ROLLBACK TO SAVEPOINT denied_check");
  }
  await become("student");
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM erp.students")).rows[0]
      .n,
    1,
  );
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM erp.contacts")).rows[0]
      .n,
    1,
  );
  await denied(
    "INSERT INTO erp.memberships(user_id,role) VALUES ($1,'admin')",
    [ids.unlinked],
  );
  assert.equal(
    (
      await client.query(
        "UPDATE erp.students SET full_name='Not permitted' RETURNING id",
      )
    ).rowCount,
    0,
  );
  await become("staff");
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM erp.contacts")).rows[0]
      .n,
    0,
  );
  assert.ok(
    (await client.query("SELECT count(*)::int AS n FROM erp.students")).rows[0]
      .n >= 1,
  );
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM erp.import_runs"))
      .rows[0].n,
    0,
  );
  await become("unlinked");
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM erp.students")).rows[0]
      .n,
    0,
  );
  await become("admin");
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM erp.contacts WHERE student_id=$1",
        [student],
      )
    ).rows[0].n,
    1,
  );
  await client.query("RESET ROLE");
  await client.query("SET LOCAL ROLE anon");
  await denied("SELECT * FROM erp.students");
  await client.query("RESET ROLE");
  await client.query("ROLLBACK");
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM auth.users WHERE id=ANY($1::uuid[])",
        [Object.values(ids)],
      )
    ).rows[0].n,
    0,
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "insert",
        "unchanged reimport",
        "changed record update",
        "student isolation",
        "staff contact restriction",
        "unlinked account denial",
        "admin access",
        "anonymous denial",
        "role escalation denied",
        "synthetic data rolled back",
      ],
    }),
  );
} catch (e) {
  if (client) await client.query("ROLLBACK");
  console.error("Database verification failed:", e.code, e.message);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
