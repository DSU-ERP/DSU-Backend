import test from "node:test";
import assert from "node:assert/strict";
import { opportunityEligibility } from "../src/modules/students/opportunities.js";
import { companySetup as setup, pdf, JD_LINES } from "./helpers/company.js";

test("company portal: invites, isolation, review, audience, consent and results", { timeout: 300000 }, async (t) => {
  const ctx = await setup();
  const { db, ids, users, companies, storage, aiCalls, app, ok, fails } = ctx;
  t.after(() => app.close());
  let tokenA;
  let requestA;
  let driveA;

  await t.test("officers invite; only the invited email can accept, once", async () => {
    const invite = await ok("POST", `/placement/companies/${companies.A}/invites`, "officer", { email: "HR@acme.test", name: "Asha" });
    assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(invite.email, "hr@acme.test");
    const stored = (await db.query("SELECT token_hash FROM company.invites WHERE id=$1", [invite.id])).rows[0].token_hash;
    assert.notEqual(stored, invite.token, "only the hash is stored");
    tokenA = invite.token;
    await fails(403, "POST", "/company/invites/accept", "wrongEmail", { token: tokenA }, /email address the invitation was sent to/);
    await fails(409, "POST", "/company/invites/accept", "s1", { token: tokenA });
    await fails(403, "GET", "/company/session", "hrA");
    const accepted = await ok("POST", "/company/invites/accept", "hrA", { token: tokenA });
    assert.deepEqual(accepted, { company: "Acme Systems", alreadyAccepted: false });
    assert.equal((await ok("POST", "/company/invites/accept", "hrA", { token: tokenA })).alreadyAccepted, true);
    await fails(409, "POST", "/company/invites/accept", "stranger", { token: tokenA }, /already been used/);
    // Company B, and an expired and a revoked invitation.
    const inviteB = await ok("POST", `/placement/companies/${companies.B}/invites`, "officer", { email: "talent@beta.test" });
    await ok("POST", "/company/invites/accept", "hrB", { token: inviteB.token });
    const expired = await ok("POST", `/placement/companies/${companies.B}/invites`, "officer", { email: "late@beta.test" });
    await db.query("UPDATE company.invites SET expires_at=now()-interval '1 minute' WHERE id=$1", [expired.id]);
    await db.query("UPDATE auth.users SET email='late@beta.test' WHERE id=$1", [users.stranger]);
    await fails(409, "POST", "/company/invites/accept", "stranger", { token: expired.token }, /expired/);
    await db.query("UPDATE auth.users SET email='someone@else.test' WHERE id=$1", [users.stranger]);
    const revoked = await ok("POST", `/placement/companies/${companies.B}/invites`, "officer", { email: "someone@else.test" });
    await ok("POST", `/placement/company-invites/${revoked.id}/revoke`, "officer", {});
    await fails(404, "POST", "/company/invites/accept", "stranger", { token: revoked.token });
    await fails(403, "POST", `/placement/companies/${companies.A}/invites`, "hrA", { email: "x@y.test" });
    const access = await ok("GET", `/placement/companies/${companies.B}/access`, "officer");
    assert.deepEqual(access.members.map((m) => m.email), ["talent@beta.test"]);
    assert.deepEqual(access.invites.map((i) => i.state).sort(), ["accepted", "expired", "revoked"]);
  });

  await t.test("session routes company members to the company portal", async () => {
    const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer hrA" } });
    assert.deepEqual(session.json().data, { role: "company", home: "/company", onboardingRequired: false });
    const me = await ok("GET", "/company/session", "hrA");
    assert.equal(me.company.name, "Acme Systems");
    assert.equal(me.member.email, "hr@acme.test");
  });

  await t.test("a JD PDF is stored privately and fills the form", async () => {
    const parsed = await ok("POST", "/company/files", "hrA", { filename: "acme-jd.pdf", data: pdf(JD_LINES), parse: true });
    assert.equal(parsed.fields.title, "Graduate Engineer");
    assert.deepEqual(parsed.fields.criteria.branches, ["CSE", "ISE"]);
    assert.equal(aiCalls.at(-1).kind, "company.drive.parse");
    assert.match(aiCalls.at(-1).system, /untrusted data/);
    assert.equal(storage.objects.size, 1);
    const [key] = storage.objects.keys();
    assert.match(key, new RegExp(`^drive-documents/company/${companies.A}/`));
    await fails(400, "POST", "/company/files", "hrA", { filename: "x.pdf", data: Buffer.from("not a pdf").toString("base64") }, /Only PDF/);
    await fails(403, "POST", "/company/files", "s1", { filename: "x.pdf", data: pdf(["x"]) });
    const saved = await ok("POST", "/company/requests", "hrA", { ...parsed.fields, jd_file_id: parsed.file.id });
    assert.deepEqual([saved.kind, saved.status, saved.jd_file.filename], ["new", "draft", "acme-jd.pdf"]);
    requestA = saved;
  });

  await t.test("incomplete requests cannot be submitted; complete ones can", async () => {
    await fails(400, "POST", `/company/requests/${requestA.id}/submit`, "hrA", {}, /work mode, graduating batch/);
    const saved = await ok("POST", "/company/requests", "hrA", {
      id: requestA.id, revision: requestA.revision, work_mode: "hybrid", ctc_fixed_lpa: 10, ctc_variable_lpa: 2, bond_months: 12,
      bond_details: "One year service agreement", joining_date: "2027-07-01",
      criteria: { batches: ["2027"], branches: ["CSE"], min_cgpa: 7.5, notes: "Strong in DSA" },
    });
    await fails(409, "POST", "/company/requests", "hrA", { id: requestA.id, revision: requestA.revision, title: "Stale" }, /changed in another window/);
    const submitted = await ok("POST", `/company/requests/${saved.id}/submit`, "hrA", {});
    assert.equal(submitted.status, "submitted");
    await fails(409, "POST", "/company/requests", "hrA", { id: saved.id, title: "Edit while submitted" }, /Withdraw it to edit/);
    requestA = submitted;
  });

  await t.test("company B can never see or change company A's requests or files", async () => {
    const draftB = await ok("POST", "/company/requests", "hrB", { title: "Beta draft" });
    assert.deepEqual((await ok("GET", "/company/requests", "hrB")).map((r) => r.id), [draftB.id]);
    await fails(404, "GET", `/company/requests/${requestA.id}`, "hrB");
    await fails(404, "POST", "/company/requests", "hrB", { id: requestA.id, title: "Hijack" });
    await fails(404, "POST", `/company/requests/${requestA.id}/withdraw`, "hrB", {});
    await fails(404, "POST", `/company/requests/${requestA.id}/delete`, "hrB", {});
    await fails(404, "GET", `/files/${requestA.jd_file_id}/link`, "hrB");
    await fails(404, "GET", `/files/${requestA.jd_file_id}/link`, "s1", undefined);
    await fails(404, "POST", "/company/requests", "hrB", { title: "Steal file", jd_file_id: requestA.jd_file_id }, /Uploaded file not found/);
    assert.match((await ok("GET", `/files/${requestA.jd_file_id}/link`, "hrA")).url, /^https:\/\/storage.invalid\//);
    assert.match((await ok("GET", `/files/${requestA.jd_file_id}/link`, "officer")).url, /^https:\/\/storage.invalid\//);
    // Officers never see a company's private drafts.
    const queue = await ok("GET", "/placement/company-requests", "officer");
    assert.deepEqual(queue.rows.map((r) => r.id), [requestA.id]);
    assert.equal(queue.counts.submitted, 1);
    await fails(404, "GET", `/placement/company-requests/${draftB.id}`, "officer");
    await fails(403, "GET", "/placement/company-requests", "hrA");
  });

  await t.test("officers return with a reason; the company fixes and resubmits", async () => {
    await fails(400, "POST", `/placement/company-requests/${requestA.id}/review`, "officer", { decision: "return" }, /Tell the company why/);
    await ok("POST", `/placement/company-requests/${requestA.id}/review`, "officer", { decision: "return", comment: "Add the stipend policy." });
    const returned = await ok("GET", `/company/requests/${requestA.id}`, "hrA");
    assert.deepEqual([returned.status, returned.review_comment], ["returned", "Add the stipend policy."]);
    const edited = await ok("POST", "/company/requests", "hrA", { id: requestA.id, openings: 12 });
    requestA = await ok("POST", `/company/requests/${edited.id}/submit`, "hrA", {});
  });

  await t.test("the audience preview combines rules with hand-picked changes", async () => {
    const spec = { batches: ["2027"], branches: ["CSE"], min_cgpa: 8, max_backlogs: 0, add: [ids.C03], remove: [ids.C02] };
    const preview = await ok("POST", "/placement/audience/preview", "officer", { spec });
    assert.deepEqual(preview.rows.map((r) => r.usn), ["C01", "C03"], "C02 removed, C04 branch, C05 batch, C06 backlogs, C03 added");
    assert.deepEqual([preview.total, preview.added, preview.removed], [2, 1, 1]);
    await fails(400, "POST", "/placement/audience/preview", "officer", { spec: { ...spec, remove: [ids.C03] } }, /both added and removed/);
    const found = await ok("GET", "/placement/audience/search?q=c04", "officer");
    assert.deepEqual(found.map((r) => r.usn), ["C04"]);
  });

  await t.test("approval publishes the drive to exactly the chosen audience", async () => {
    const before = (await db.query("SELECT count(*)::int n FROM student.notifications")).rows[0].n;
    const result = await ok("POST", `/placement/company-requests/${requestA.id}/review`, "officer", {
      decision: "approve", revision: requestA.revision,
      audience: { batches: ["2027"], branches: ["CSE"], min_cgpa: 8, max_backlogs: 0, add: [ids.C03], remove: [ids.C02] },
    });
    assert.equal(result.audience, 2);
    driveA = result.driveId;
    const drive = (await db.query("SELECT * FROM placement.drives WHERE id=$1", [driveA])).rows[0];
    assert.deepEqual([drive.published, drive.audience_mode, drive.origin, drive.academic_year, drive.work_mode], [true, true, "company", "2026-27", "hybrid"]);
    const notified = (await db.query(
      "SELECT m.student_id FROM student.notifications n JOIN erp.memberships m ON m.user_id=n.user_id WHERE n.href LIKE '%'||$1 ORDER BY 1", [driveA])).rows;
    assert.deepEqual(notified.map((r) => r.student_id).sort(), [ids.C01, ids.C03].sort(), "only linked audience members are notified");
    assert.equal((await db.query("SELECT count(*)::int n FROM student.notifications")).rows[0].n, before + 2);
    assert.match((await db.query("SELECT body FROM student.notifications WHERE user_id=$1", [users.s1])).rows[0].body, /selected you/);
    const request = await ok("GET", `/company/requests/${requestA.id}`, "hrA");
    assert.deepEqual([request.status, request.drive_id], ["approved", driveA]);
    await fails(409, "POST", `/placement/company-requests/${requestA.id}/review`, "officer", { decision: "approve", audience: { batches: ["2027"] } });
  });

  await t.test("students outside the audience cannot see, open or apply", async () => {
    const inside = await ok("GET", "/student/opportunities", "s1");
    assert.deepEqual(inside.rows.map((r) => r.id), [driveA]);
    const row = inside.rows[0];
    assert.equal(row.company_about, "Builds payments software.");
    assert.equal(row.jd_file.filename, "acme-jd.pdf");
    assert.deepEqual([row.ctc_fixed_lpa, row.bond_months, row.work_mode, row.joining_date], ["10", 12, "hybrid", "2027-07-01"]);
    assert.equal(row.eligibility.eligible, true);
    for (const outsider of ["s4", "s5"]) {
      assert.equal((await ok("GET", "/student/opportunities", outsider)).rows.length, 0);
      await fails(404, "GET", `/student/opportunities/${driveA}`, outsider);
      await fails(404, "GET", `/files/${requestA.jd_file_id}/link`, outsider);
    }
    assert.match((await ok("GET", `/files/${requestA.jd_file_id}/link`, "s1")).url, /storage.invalid/);
    // The company's name is not exposed to students who received none of its drives.
    const client = await ctx.pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id',$1,true)", [users.s5]);
    assert.equal((await client.query("SELECT count(*)::int n FROM placement.companies")).rows[0].n, 0);
    await client.query("ROLLBACK");
  });

  await t.test("applying needs consent and, for company drives, a resume; SQL and display agree", async () => {
    await fails(400, "POST", `/student/opportunities/${driveA}/apply`, "s1", { confirmed: true });
    await fails(400, "POST", `/student/opportunities/${driveA}/apply`, "s1", { confirmed: true, consent: true }, /Attach your resume/);
    const upload = await ok("POST", "/student/documents", "s1", { filename: "resume.pdf", kind: "resume", data: pdf(["Student C01 resume", "Java SQL projects"]) });
    assert.ok(upload.file?.id, "resume PDF stored as a file");
    const resumes = await ok("GET", "/student/resumes", "s1");
    assert.deepEqual(resumes.rows.map((r) => r.id), [upload.file.id]);
    await fails(404, "POST", `/student/opportunities/${driveA}/apply`, "s3", { confirmed: true, consent: true, resumeFileId: upload.file.id }, /Resume not found/);
    const applied = await ok("POST", `/student/opportunities/${driveA}/apply`, "s1", { confirmed: true, consent: true, resumeFileId: upload.file.id });
    assert.equal(applied.status, "registered");
    const reg = (await db.query("SELECT consent_at,shared_fields,resume_file_id FROM placement.registrations WHERE drive_id=$1", [driveA])).rows[0];
    assert.ok(reg.consent_at);
    assert.ok(reg.shared_fields.includes("resume") && reg.shared_fields.includes("phone"));
    // A hand-picked student below the rule's CGPA is eligible on both sides.
    const official = { cgpa: "6.90", current_backlog: 0, attendance: "90", department_short_name: "CSE" };
    const drive = (await db.query("SELECT * FROM placement.drives WHERE id=$1", [driveA])).rows[0];
    assert.equal(opportunityEligibility(official, { ...drive, registration_deadline: null }, 0).eligible, true);
    const sql = await ctx.pool.connect();
    await sql.query("BEGIN");
    await sql.query("SELECT set_config('app.user_id',$1,true)", [users.s3]);
    assert.equal((await sql.query("SELECT student.drive_eligibility($1) AS r", [driveA])).rows[0].r.eligible, true);
    await sql.query("ROLLBACK");
  });

  await t.test("applicants stay hidden until released, then only consenting ones are shared", async () => {
    // An officer-added registration without consent is never shared.
    await db.query("INSERT INTO placement.registrations(drive_id,student_id) VALUES($1,$2)", [driveA, ids.C03]);
    const hidden = await ok("GET", `/company/drives/${driveA}/applicants`, "hrA");
    assert.deepEqual([hidden.released, hidden.rows.length], [false, 0]);
    assert.equal((await ok("GET", `/company/drives/${driveA}`, "hrA")).applicants, null);
    await fails(404, "GET", `/company/drives/${driveA}/applicants`, "hrB");
    await fails(404, "GET", `/company/drives/${driveA}`, "hrB");
    assert.deepEqual(await ok("GET", "/company/drives", "hrB"), []);
    await fails(403, "POST", `/placement/drives/${driveA}/release`, "hrA", { release: true });
    const released = await ok("POST", `/placement/drives/${driveA}/release`, "officer", { release: true });
    assert.deepEqual([released.released, released.shared], [true, 1]);
    const shared = await ok("GET", `/company/drives/${driveA}/applicants`, "hrA");
    assert.equal(shared.rows.length, 1);
    const [row] = shared.rows;
    assert.deepEqual([row.usn, row.branch, row.batch, row.cgpa, row.backlogs, row.email, row.phone], ["C01", "CSE", "2027", "9.10", 0, "c01@dsu.test", "9000001"]);
    assert.equal(row.resume.filename, "resume.pdf");
    assert.equal(JSON.stringify(row).includes("Private"), false, "family contact details are never shared");
    assert.match((await ok("GET", `/files/${row.resume.id}/link`, "hrA")).url, /storage.invalid\/resumes/);
    await fails(404, "GET", `/files/${row.resume.id}/link`, "hrB");
    await fails(404, "GET", `/files/${row.resume.id}/link`, "s3");
    assert.equal((await ok("GET", `/company/drives/${driveA}`, "hrA")).applicants, 1);
  });

  await t.test("the company records rounds; the final pass selects the student", async () => {
    const reg = (await ok("GET", `/company/drives/${driveA}/applicants`, "hrA")).rows[0].registrationId;
    await fails(404, "POST", `/company/drives/${driveA}/results`, "hrB", { registration_ids: [reg], round: 1, result: "pass" });
    const other = (await db.query("SELECT id FROM placement.registrations WHERE drive_id=$1 AND student_id=$2", [driveA, ids.C03])).rows[0].id;
    await fails(404, "POST", `/company/drives/${driveA}/results`, "hrA", { registration_ids: [other], round: 1, result: "pass" }, /not part of this drive/);
    await fails(409, "POST", `/company/drives/${driveA}/results`, "hrA", { registration_ids: [reg], round: 2, result: "pass" });
    for (const round of [1, 2, 3]) await ok("POST", `/company/drives/${driveA}/results`, "hrA", { registration_ids: [reg], round, result: "pass" });
    const after = (await ok("GET", `/company/drives/${driveA}/applicants`, "hrA")).rows[0];
    assert.deepEqual([after.status, after.results.length], ["selected", 3]);
    assert.equal((await ok("GET", `/company/drives/${driveA}`, "hrA")).selected, 1);
    const events = (await db.query("SELECT count(*)::int n FROM placement.events WHERE action='company.round.record' AND drive_id=$1", [driveA])).rows[0].n;
    assert.equal(events, 3);
  });

  await t.test("a change to a live drive waits for approval; the live drive is unchanged meanwhile", async () => {
    const change = await ok("POST", "/company/requests", "hrA", { drive_id: driveA });
    assert.deepEqual([change.kind, change.title, change.criteria.notes], ["change", "Graduate Engineer", "Strong in DSA"]);
    await fails(409, "POST", "/company/requests", "hrA", { drive_id: driveA }, /already has an open change request/);
    await ok("POST", "/company/requests", "hrA", { id: change.id, package_lpa: 14, location: "Pune" });
    await ok("POST", `/company/requests/${change.id}/submit`, "hrA", {});
    assert.equal((await ok("GET", `/company/drives/${driveA}`, "hrA")).packageLpa, 12);
    await ok("POST", `/placement/company-requests/${change.id}/review`, "officer", { decision: "approve" });
    const live = await ok("GET", `/company/drives/${driveA}`, "hrA");
    assert.deepEqual([live.packageLpa, live.location, live.openChange], [14, "Pune", null]);
  });

  await t.test("officers can retarget any drive; revoked members lose access at once", async () => {
    const saved = await ok("POST", `/placement/drives/${driveA}/audience`, "officer", { batches: ["2027"], branches: ["CSE", "ECE"], min_cgpa: 8, max_backlogs: 0, add: [ids.C03] });
    assert.equal(saved.audience, 4, "C01, C02, C04 by rule plus C03 added");
    assert.equal(saved.notified, 1, "only the newly reached linked student (C04) is notified");
    assert.equal((await ok("GET", "/student/opportunities", "s4")).rows.length, 1);
    // Adding by hand someone the filters already include counts them once and saves.
    const overlap = { batches: ["2027"], branches: ["CSE", "ECE"], min_cgpa: 8, max_backlogs: 0, add: [ids.C01, ids.C03] };
    const preview = await ok("POST", "/placement/audience/preview", "officer", { spec: overlap });
    assert.deepEqual([preview.total, preview.added, preview.rows.length], [4, 1, 4]);
    assert.equal((await ok("POST", `/placement/drives/${driveA}/audience`, "officer", overlap)).audience, 4);
    // Selected students only: the filters are ignored, even across batches.
    const picked = { mode: "selected", batches: ["2027"], branches: ["CSE"], min_cgpa: 9, add: [ids.C04, ids.C05] };
    const pickedPreview = await ok("POST", "/placement/audience/preview", "officer", { spec: picked });
    assert.deepEqual(pickedPreview.rows.map((r) => r.usn), ["C04", "C05"]);
    assert.deepEqual([pickedPreview.spec.mode, pickedPreview.spec.branches, pickedPreview.spec.min_cgpa], ["selected", [], null]);
    assert.equal((await ok("POST", `/placement/drives/${driveA}/audience`, "officer", picked)).audience, 2);
    const state = await ok("GET", `/placement/drives/${driveA}/audience`, "officer");
    assert.deepEqual([state.size, state.rules.selected_only, state.changes.add.sort()], [2, true, [ids.C04, ids.C05].sort()]);
    await fails(400, "POST", `/placement/drives/${driveA}/audience`, "officer", { mode: "selected", add: [] }, /Select at least one student/);
    await fails(400, "POST", `/placement/drives/${driveA}/audience`, "officer", { add: [ids.C04] }, /graduating batches/);
    await ok("POST", `/placement/company-members/${users.hrA}/revoke`, "officer", {});
    await fails(403, "GET", "/company/drives", "hrA");
    const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer hrA" } });
    assert.equal(session.json().data.role, null);
  });
});
