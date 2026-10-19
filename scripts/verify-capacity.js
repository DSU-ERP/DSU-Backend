// Local synthetic data only. This is a dataset check, not a production load claim.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../test/helpers/database.js";
import { buildApp } from "../src/app.js";
const { db, pool } = await testDatabase();
const admin = randomUUID(), studentUser = randomUUID();
let app;
try {
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [admin, studentUser]);
  await db.exec("INSERT INTO erp.students(enrollment_no,full_name,department_short_name,source_batch,source_hash) SELECT 'S'||lpad(n::text,6,'0'),'Synthetic Student '||n,(ARRAY['CSE','ECE','ME','CIVIL'])[1+n%4],(2026+n%4)::text,'fixture' FROM generate_series(1,50000) n");
  await db.exec("INSERT INTO erp.academics(student_id,cgpa,current_backlog,attendance) SELECT id,6.75,0,90 FROM erp.students");
  const id = (await db.query("SELECT id FROM erp.students WHERE enrollment_no='S000001'")).rows[0].id;
  await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'admin',NULL),($2,'student',$3)", [admin, studentUser, id]);
  await db.exec("ANALYZE erp.students; ANALYZE erp.academics");
  app = await buildApp({ pool, env: { SERVICE_TOKEN: "x".repeat(32) }, logger: false, verify: async token => ({ id: token === "admin" ? admin : studentUser }) });
  const timings = [];
  for (const [path, user, check] of [
    ["/student/me", "student", data => assert.equal(data.enrollment_no, "S000001")],
    ["/portal/read?" + new URLSearchParams({ path: "/students?page=1&limit=25" }), "admin", data => assert.equal(data.length, 25)],
    ["/portal/read?" + new URLSearchParams({ path: "/overview" }), "admin", data => assert.equal(data.students, 50000)],
  ]) {
    const started = performance.now();
    const response = await app.inject({ url: "/api/v1" + path, headers: { authorization: "Bearer " + user } });
    assert.equal(response.statusCode, 200); check(response.json().data);
    timings.push({ route: path.split("?")[0], durationMs: Math.round(performance.now() - started) });
  }
  console.log(JSON.stringify({ passed: true, students: 50000, environment: "isolated PGlite; synthetic users; no network or production traffic", timings }));
} finally { if (app) await app.close(); else await db.close(); }
