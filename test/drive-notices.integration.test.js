import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { opportunityEligibility } from "../src/modules/students/opportunities.js";
import { testDatabase } from "./helpers/database.js";

test("publishing a drive notifies only students who meet every criterion", { timeout: 120000 }, async (t) => {
  const { db, pool } = await testDatabase();
  const officer = randomUUID();
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [officer]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [officer]);
  const users = {};
  async function student(key, { cgpa, backlogs = 0, attendance = 90, dept = "CSE", batch = "2027", linked = true }) {
    const id = randomUUID();
    await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name) VALUES($1,$2,$3,$4,'h',$5)", [id, "USN-" + key, "Student " + key, batch, dept]);
    await db.query("INSERT INTO erp.academics(student_id,cgpa,current_backlog,attendance) VALUES($1,$2,$3,$4)", [id, cgpa, backlogs, attendance]);
    if (linked) {
      users[key] = randomUUID();
      await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [users[key], key + "@x.invalid"]);
      await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [users[key], id]);
    }
    return id;
  }
  await student("top", { cgpa: 9.1 });
  await student("edge", { cgpa: 8.0 });
  await student("low", { cgpa: 7.2 });
  await student("arrears", { cgpa: 9.0, backlogs: 2 });
  await student("absent", { cgpa: 9.0, attendance: 60 });
  await student("mech", { cgpa: 9.0, dept: "ME" });
  await student("senior", { cgpa: 9.5, batch: "2026" });
  await student("unlinked", { cgpa: 9.5, linked: false });
  const app = await buildApp({ pool, logger: false, env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 1000 }, verify: async () => ({ id: officer }) });
  t.after(() => app.close());
  const act = (action, payload) => app.inject({ method: "POST", url: "/api/v1/placement/actions/" + action, headers: { authorization: "Bearer o" }, payload: { payload, requestId: randomUUID() } });
  const company = (await act("company.save", { name: "Acme" })).json().data;
  const notified = async () => (await db.query("SELECT u.email FROM student.notifications n JOIN auth.users u ON u.id=n.user_id WHERE n.href LIKE '/student/placement?drive=%' ORDER BY 1")).rows.map((r) => r.email.split("@")[0]);
  const fields = { company_id: company.id, title: "Graduate engineer", package_lpa: "8", academic_year: "2026-27", batch: "2027", min_cgpa: "8", max_backlogs: "0", branches: ["CSE"], min_attendance: "75", rounds: ["Interview"] };

  // A draft (unpublished) drive notifies nobody.
  const draft = (await act("drive.save", { ...fields, published: false })).json().data;
  assert.equal(draft.min_attendance, 75);
  assert.deepEqual(await notified(), []);

  // Publishing notifies only batch 2027 CSE students with CGPA ≥ 8, 0 backlogs, attendance ≥ 75 and an account.
  const live = (await act("drive.save", { ...fields, id: draft.id, revision: draft.revision, published: true })).json().data;
  assert.deepEqual(await notified(), ["edge", "top"]);
  const note = (await db.query("SELECT title,body FROM student.notifications WHERE user_id=$1", [users.top])).rows[0];
  assert.match(note.title, /New drive for you: Acme, Graduate engineer/);
  assert.match(note.body, /You meet the eligibility criteria/);

  // Saving again does not repeat; relaxing CGPA reaches only the newly eligible student.
  const resaved = (await act("drive.save", { ...fields, id: live.id, revision: live.revision, published: true, title: "Graduate engineer II" })).json().data;
  assert.deepEqual(await notified(), ["edge", "top"]);
  const relaxed = (await act("drive.save", { ...fields, id: live.id, revision: resaved.revision, published: true, min_cgpa: "7" })).json().data;
  assert.deepEqual(await notified(), ["edge", "low", "top"]);
  assert.equal((await db.query("SELECT count(*)::int n FROM placement.drive_notices WHERE drive_id=$1", [live.id])).rows[0].n, 3);

  // The officer's drive page reports eligible and notified counts.
  const report = (await app.inject({ url: "/api/v1/placement/drive?id=" + live.id, headers: { authorization: "Bearer o" } })).json().data;
  assert.equal(report.counts.notified, 3);
  assert.equal(report.counts.eligible, 4); // includes the eligible student without an account yet

  // Bad attendance input is a clear validation error.
  const bad = await act("drive.save", { ...fields, id: live.id, revision: relaxed.revision, min_attendance: "120" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error.message, /attendance/);

  // Student-side eligibility explains the attendance rule.
  const gaps = opportunityEligibility({ cgpa: "9.00", current_backlog: 0, attendance: "60", department_short_name: "CSE" },
    { min_cgpa: "8", max_backlogs: 0, min_attendance: "75", branches: [], package_lpa: "8", published: true, status: "upcoming", registration_deadline: null }, 0, "2026-10-19").gaps;
  assert.deepEqual(gaps, ["Requires attendance of 75% or above."]);
});
