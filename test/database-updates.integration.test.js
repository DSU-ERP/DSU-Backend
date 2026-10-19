import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp, httpError } from "../src/app.js";
import { schemaStatus } from "../src/platform/database/readiness.js";
import { testDatabase } from "./helpers/database.js";

test("readiness, drive saves and officer removal behave safely", { timeout: 120000 }, async (t) => {
  const { db, pool } = await testDatabase();
  assert.deepEqual(await schemaStatus(pool), { ready: true, missing: [] });
  const officer = randomUUID();
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [officer]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [officer]);
  const app = await buildApp({
    pool, logger: false,
    env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 100 },
    verify: async () => ({ id: officer }),
  });
  t.after(() => app.close());
  assert.equal((await app.inject("/health/ready")).json().status, "ready");
  const act = (action, payload) => app.inject({
    method: "POST", url: "/api/v1/placement/actions/" + action,
    headers: { authorization: "Bearer officer" },
    payload: { payload, requestId: randomUUID() },
  });
  const company = (await act("company.save", { name: "Synthetic Company" })).json().data;
  const fields = { company_id: company.id, title: "Engineer", package_lpa: "8", academic_year: "2028-29", batch: "2028", min_cgpa: "6.75", max_backlogs: "0", rounds: ["Interview"] };
  const created = (await act("drive.save", { ...fields, published: true, location: "Bengaluru", skills: "SQL" })).json().data;
  assert.equal(created.published, true);
  // An older client that omits the new fields must not unpublish or clear them.
  const resaved = (await act("drive.save", { ...fields, id: created.id, revision: created.revision, title: "Engineer II" })).json().data;
  assert.equal(resaved.title, "Engineer II");
  assert.equal(resaved.published, true);
  assert.equal(resaved.location, "Bengaluru");
  assert.equal(resaved.skills, "SQL");
  const hidden = (await act("drive.save", { ...fields, id: created.id, revision: resaved.revision, published: false, location: "" })).json().data;
  assert.equal(hidden.published, false);
  assert.equal(hidden.location, null);
  // Deliberate SQL validation messages reach the user instead of a generic 400.
  const invalid = await act("drive.save", { ...fields, rounds: [] });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.message, "Provide one to twenty distinct round names.");

  // Deleting an officer keeps assigned assessments (and student results).
  const assessment = randomUUID();
  await db.query("INSERT INTO student.assessments(id,creator_id,kind,title,questions,config) VALUES($1,$2,'assigned','Quiz','[]','{}')", [assessment, officer]);
  await db.query("INSERT INTO student.broadcasts(creator_id,title,body) VALUES($1,'Notice','Body')", [officer]);
  await db.query("INSERT INTO student.calendar_events(created_by,title,kind,starts_at,ends_at) VALUES($1,'Class','class',now(),now()+interval '1 hour')", [officer]);
  await db.query("DELETE FROM placement.officers WHERE user_id=$1", [officer]);
  await db.query("DELETE FROM auth.users WHERE id=$1", [officer]);
  const kept = await db.query("SELECT creator_id FROM student.assessments WHERE id=$1", [assessment]);
  assert.equal(kept.rows.length, 1);
  assert.equal(kept.rows[0].creator_id, null);
});

test("a database that is behind the code reports a pending update, not a generic failure", async (t) => {
  const pool = {
    query: async () => ({ rows: [{ kind: "function", name: "student.is_officer" }] }),
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes("is_officer"))
          throw Object.assign(new Error("function student.is_officer() does not exist"), { code: "42883" });
        return { rows: [] };
      },
      release() {},
    }),
    end: async () => {},
  };
  const app = await buildApp({
    pool, logger: false,
    env: { SERVICE_TOKEN: "x".repeat(32) },
    verify: async () => ({ id: randomUUID() }),
  });
  t.after(() => app.close());
  const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer user" } });
  assert.equal(session.statusCode, 503);
  assert.equal(session.json().error.code, "DATABASE_UPDATE_PENDING");
  const ready = await app.inject("/health/ready");
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().reason, "database_update_pending");
  assert.ok(httpError(400, "X", "y").expose);
});

test("migrations applied from a Windows CRLF checkout are not reported as changed", async () => {
  const { checksumMatches } = await import("../src/platform/database/migrations.js");
  const { createHash } = await import("node:crypto");
  const lf = "CREATE TABLE x(id int);\nSELECT 1;\n";
  const crlf = createHash("sha256").update(lf.replace(/\n/g, "\r\n")).digest("hex");
  assert.ok(checksumMatches(lf, crlf));
  assert.ok(!checksumMatches(lf + "-- edited\n", crlf));
});
