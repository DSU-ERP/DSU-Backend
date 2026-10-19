import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { placementSummary } from "../src/modules/students/opportunities.js";
import { testDatabase } from "./helpers/database.js";

test("company details, hiring targets, round tracking and student track records", { timeout: 120000 }, async (t) => {
  const { db, pool } = await testDatabase();
  const officer = randomUUID(), studentUser = randomUUID(), other = randomUUID();
  const student = randomUUID(), rival = randomUUID();
  await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'o@x.invalid',now()),($2,'s@x.invalid',now()),($3,'r@x.invalid',now())", [officer, studentUser, other]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [officer]);
  for (const [id, usn] of [[student, "USN-A"], [rival, "USN-B"]]) {
    await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name) VALUES($1,$2,$2,'2027','h','CSE')", [id, usn]);
    await db.query("INSERT INTO erp.academics(student_id,cgpa,current_backlog,attendance) VALUES($1,8.5,0,90)", [id]);
  }
  await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2),($3,'student',$4)", [studentUser, student, other, rival]);
  const app = await buildApp({ pool, logger: false, env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 1000 },
    verify: async (token) => ({ id: { officer, student: studentUser, other }[token] }) });
  t.after(() => app.close());
  const act = async (action, payload, expected = 200) => {
    const response = await app.inject({ method: "POST", url: "/api/v1/placement/actions/" + action, headers: { authorization: "Bearer officer" }, payload: { payload, requestId: randomUUID() } });
    assert.equal(response.statusCode, expected, response.body);
    return response.json();
  };
  const read = async (path, who = "officer") => (await app.inject({ url: "/api/v1" + path, headers: { authorization: "Bearer " + who } })).json().data;

  // 1. Company management with full details.
  const company = (await act("company.save", { name: "Acme Systems", industry: "IT services", headquarters: "Bengaluru",
    about: "Product engineering firm.", hiring_roles: "Software engineer, Data analyst", job_categories: ["Software / IT", "Data & analytics"],
    hr_name: "Priya", hr_email: "hr@acme.example", website: "https://acme.example" })).data;
  assert.deepEqual(company.job_categories, ["Data & analytics", "Software / IT"]);
  assert.equal(company.headquarters, "Bengaluru");
  const edited = (await act("company.save", { id: company.id, revision: company.revision, name: "Acme Systems", industry: "IT services" })).data;
  assert.equal(edited.hiring_roles, "Software engineer, Data analyst"); // untouched fields are kept

  // 2. Drive with role, category, type and openings.
  const base = { company_id: company.id, title: "Graduate engineer", package_lpa: "8", academic_year: "2026-27", batch: "2027",
    min_cgpa: "7", max_backlogs: "0", rounds: ["Aptitude", "Technical", "HR"], job_category: "Software / IT", employment_type: "full-time", openings: "2", published: true };
  const drive = (await act("drive.save", base)).data;
  assert.equal(drive.openings, 2);
  assert.equal(drive.employment_type, "full-time");
  await act("drive.save", { ...base, openings: "0" }, 400);
  await act("drive.save", { ...base, employment_type: "freelance" }, 400);

  // 3. Students apply (their response), officer runs rounds and makes an offer.
  for (const who of ["student", "other"]) {
    const applied = await app.inject({ method: "POST", url: "/api/v1/student/opportunities/" + drive.id + "/apply", headers: { authorization: "Bearer " + who }, payload: { confirmed: true } });
    assert.equal(applied.statusCode, 200, applied.body);
  }
  const regs = (await db.query("SELECT id,student_id FROM placement.registrations WHERE drive_id=$1", [drive.id])).rows;
  const mine = regs.find((r) => r.student_id === student).id, theirs = regs.find((r) => r.student_id === rival).id;
  await act("round.record", { drive_id: drive.id, registration_ids: [mine, theirs], round: 1, result: "pass" });
  await act("round.record", { drive_id: drive.id, registration_ids: [theirs], round: 2, result: "fail" });
  await act("round.record", { drive_id: drive.id, registration_ids: [mine], round: 2, result: "pass" });
  await act("round.record", { drive_id: drive.id, registration_ids: [mine], round: 3, result: "pass" });
  await act("offer.create", { drive_id: drive.id, registration_ids: [mine] });

  // 4. Officer views: drive hiring progress and company totals.
  const report = await read("/placement/drive?id=" + drive.id);
  assert.equal(report.counts.openings, 2);
  assert.equal(report.counts.registered, 2);
  assert.equal(report.counts.rounds_conducted, 3);
  assert.equal(report.counts.placed, 1);
  assert.equal(report.counts.active_offers, 1);
  const companies = await read("/placement/companies");
  const row = companies.rows.find((r) => r.id === company.id);
  assert.equal(Number(row.openings), 2);
  assert.equal(Number(row.selected), 1);

  // 5. The student's own track record.
  const record = await read("/student/placement-record", "student");
  assert.equal(record.registrations.length, 1);
  assert.equal(record.registrations[0].company, "Acme Systems");
  assert.deepEqual(record.registrations[0].results.map((r) => r.result), ["pass", "pass", "pass"]);
  assert.deepEqual({ applied: record.summary.applied, interviews: record.summary.interviews, cleared: record.summary.roundsCleared, offers: record.summary.activeOffers, highest: record.summary.highestPackage, category: record.summary.highestCategory },
    { applied: 1, interviews: 1, cleared: 3, offers: 1, highest: 8, category: "dream" });
  const rivalRecord = await read("/student/placement-record", "other");
  assert.equal(rivalRecord.summary.roundsCleared, 1);
  assert.equal(rivalRecord.summary.offers, 0);
  assert.equal(rivalRecord.registrations[0].status, "rejected");
  // Officers are not students: no record endpoint for them.
  assert.equal((await app.inject({ url: "/api/v1/student/placement-record", headers: { authorization: "Bearer officer" } })).statusCode, 403);
});

test("track record summary counts absences, interviews and the highest active offer", () => {
  const summary = placementSummary({
    registrations: [
      { status: "rejected", results: [{ result: "pass" }, { result: "fail" }] },
      { status: "registered", results: [{ result: "absent" }] },
      { status: "placed", results: [{ result: "pass" }] },
    ],
    offers: [{ status: "accepted", package_lpa: "12" }, { status: "revoked", package_lpa: "20" }],
  });
  assert.equal(summary.applied, 3);
  assert.equal(summary.interviews, 2);
  assert.equal(summary.absences, 1);
  assert.equal(summary.roundsCleared, 2);
  assert.equal(summary.highestPackage, 12);
  assert.equal(summary.highestCategory, "super-dream");
});
