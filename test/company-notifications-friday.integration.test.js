import test from "node:test";
import assert from "node:assert/strict";
import { companySetup, EXTRACTION, pdf } from "./helpers/company.js";
import { COMPANY_FRIDAY_SYSTEM } from "../src/modules/company/friday.js";

// Records every AI call; answers each kind with a valid, fixed response.
function fakeAi() {
  const calls = [];
  const respond = (call) => {
    calls.push(call);
    if (call.kind === "company.drive.parse") return EXTRACTION;
    if (call.kind === "company.chat") return { text: "Answer from the company context." };
    return { text: "Answer from your placement context.", card: null, citations: [] };
  };
  return { calls, respond };
}

async function flow() {
  const ai = fakeAi();
  const ctx = await companySetup({ studentAi: ai.respond });
  const { ok, companies, ids } = ctx;
  for (const [key, email, who] of [["A", "hr@acme.test", "hrA"], ["B", "talent@beta.test", "hrB"]]) {
    const invite = await ok("POST", `/placement/companies/${companies[key]}/invites`, "officer", { email });
    await ok("POST", "/company/invites/accept", who, { token: invite.token });
  }
  const draft = await ok("POST", "/company/requests", "hrA", {
    title: "Graduate Engineer", description: "Build and test backend services for payments.", employment_type: "full-time",
    package_lpa: 12, openings: 5, work_mode: "onsite", rounds: ["Online test", "Interview"], location: "Bengaluru",
    registration_deadline: "2099-01-15", criteria: { batches: ["2027"], branches: ["CSE"] },
  });
  // A second company's draft, so isolation is checked against real rows.
  const draftB = await ok("POST", "/company/requests", "hrB", { title: "Beta Analyst", employment_type: "internship" });
  return { ...ctx, ai, draft, draftB, ids };
}

const unread = (ok, who) => ok("GET", "/notifications", who);

test("notifications reach the right people and mark-as-read removes them", { timeout: 300000 }, async (t) => {
  const ctx = await flow();
  const { ok, fails, db, ids, draft, app } = ctx;
  t.after(() => app.close());
  let driveId;

  await t.test("a submitted drive notifies every officer, never another company", async () => {
    assert.equal((await unread(ok, "officer")).unread, 0);
    await ok("POST", `/company/requests/${draft.id}/submit`, "hrA", {});
    const officer = await unread(ok, "officer");
    assert.equal(officer.audience, "officer");
    assert.deepEqual(officer.rows.map((r) => [r.kind, r.title, r.href]), [
      ["request.submitted", "Acme Systems submitted a new drive: Graduate Engineer", `/placement/drive-requests/${draft.id}`],
    ]);
    assert.equal((await unread(ok, "hrB")).unread, 0);
    assert.equal((await unread(ok, "hrA")).unread, 0);
  });

  await t.test("decisions notify the company; approval notifies the chosen students", async () => {
    await ok("POST", `/placement/company-requests/${draft.id}/review`, "officer", { decision: "return", comment: "Add the joining date." });
    const returned = await unread(ok, "hrA");
    assert.deepEqual(returned.rows.map((r) => [r.kind, r.title, r.body]), [["request.returned", "Changes requested: Graduate Engineer", "Add the joining date."]]);
    await ok("POST", "/company/requests", "hrA", { id: draft.id, joining_date: "2027-07-01" });
    await ok("POST", `/company/requests/${draft.id}/submit`, "hrA", {});
    const approved = await ok("POST", `/placement/company-requests/${draft.id}/review`, "officer", {
      decision: "approve", audience: { batches: ["2027"], branches: ["CSE"], min_cgpa: 6, add: [], remove: [ids.C02] },
    });
    driveId = approved.driveId;
    const company = await unread(ok, "hrA");
    assert.equal(company.rows[0].kind, "request.approved");
    assert.equal(company.rows[0].href, `/company/drives/${driveId}`);
    const student = await unread(ok, "s1");
    assert.equal(student.audience, "student");
    assert.match(student.rows[0].title, /New drive for you: Acme Systems, Graduate Engineer/);
    assert.equal((await unread(ok, "s4")).unread, 0, "ECE student outside the audience");
    assert.equal((await unread(ok, "hrB")).unread, 0);
  });

  await t.test("release, results, selection and offer each notify once", async () => {
    const upload = await ok("POST", "/student/documents", "s1", { filename: "resume.pdf", kind: "resume", data: pdf(["Resume of C01", "Projects in Java and SQL services"]) });
    await ok("POST", `/student/opportunities/${driveId}/apply`, "s1", { confirmed: true, consent: true, resumeFileId: upload.file.id });
    await ok("POST", `/placement/drives/${driveId}/release`, "officer", { release: true });
    const released = (await unread(ok, "hrA")).rows.find((r) => r.kind === "applicants.released");
    assert.match(released.body, /^1 consenting applicant/);
    const reg = (await ok("GET", `/company/drives/${driveId}/applicants`, "hrA")).rows[0].registrationId;
    await ok("POST", `/company/drives/${driveId}/results`, "hrA", { registration_ids: [reg], round: 1, result: "pass" });
    await ok("POST", `/company/drives/${driveId}/results`, "hrA", { registration_ids: [reg], round: 2, result: "pass" });
    const officer = (await unread(ok, "officer")).rows.filter((r) => r.kind === "results.recorded");
    assert.deepEqual(officer.map((r) => r.title).sort(), [
      "Acme Systems recorded round 1 results: Graduate Engineer",
      "Acme Systems recorded round 2 results: Graduate Engineer",
    ]);
    const selected = (await unread(ok, "s1")).rows.filter((r) => /selected/.test(r.title));
    assert.deepEqual(selected.map((r) => r.title), ["You have been selected: Acme Systems, Graduate Engineer"]);
    await ok("POST", "/placement/actions/offer.create", "officer", { requestId: crypto.randomUUID(), payload: { drive_id: driveId, registration_ids: [reg] } });
    const offer = (await unread(ok, "s1")).rows.filter((r) => /^Offer from/.test(r.title));
    assert.deepEqual(offer.map((r) => r.body), ["12 LPA. Open your placement record for details."]);
  });

  await t.test("mark as read removes one item for that user only; read-all clears the list", async () => {
    await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [ctx.users.stranger]);
    await ok("POST", `/company/requests`, "hrA", { drive_id: driveId }).then((change) => ok("POST", `/company/requests/${change.id}/submit`, "hrA", {}));
    const mine = await unread(ok, "officer");
    const other = await unread(ok, "stranger");
    const target = mine.rows[0];
    assert.equal(other.rows[0].title, target.title, "each officer has their own copy");
    assert.deepEqual(await ok("POST", `/notifications/${target.id}/read`, "officer", {}), { read: true });
    assert.equal((await unread(ok, "officer")).unread, mine.unread - 1);
    assert.equal((await unread(ok, "stranger")).unread, other.unread, "another officer still sees it");
    assert.deepEqual(await ok("POST", `/notifications/${target.id}/read`, "hrB", {}), { read: false }, "cannot touch another user's notice");
    const row = (await db.query("SELECT read_at FROM erp.notifications WHERE id=$1", [target.id])).rows[0];
    assert.ok(row.read_at, "the row is kept with its read time");
    // Students: a personal notice and a batch broadcast.
    await db.query("INSERT INTO student.broadcasts(creator_id,batch,title,body) VALUES($1,'2027','Resume clinic on Friday','Room 204')", [ctx.users.officer]);
    const before = await unread(ok, "s1");
    const broadcast = before.rows.find((r) => r.source === "broadcast");
    await ok("POST", `/notifications/${broadcast.id}/read`, "s1", { source: "broadcast" });
    assert.equal((await unread(ok, "s1")).rows.some((r) => r.id === broadcast.id), false);
    assert.equal((await unread(ok, "s3")).rows.some((r) => r.id === broadcast.id), true, "other students keep the broadcast");
    await ok("POST", "/notifications/read-all", "s1", {});
    assert.equal((await unread(ok, "s1")).unread, 0);
    await fails(403, "GET", "/notifications", "wrongEmail");
  });
});

test("FRIDAY context never crosses roles or companies", { timeout: 300000 }, async (t) => {
  const ctx = await flow();
  const { ok, fails, ai, draft, ids, app, db } = ctx;
  t.after(() => app.close());
  await ok("POST", `/company/requests/${draft.id}/submit`, "hrA", {});
  const { driveId } = await ok("POST", `/placement/company-requests/${draft.id}/review`, "officer", {
    decision: "approve", audience: { batches: ["2027"], branches: ["CSE"], add: [], remove: [] },
  });
  const upload = await ok("POST", "/student/documents", "s1", { filename: "resume.pdf", kind: "resume", data: pdf(["Resume of C01", "Projects in Java and SQL services"]) });
  await ok("POST", `/student/opportunities/${driveId}/apply`, "s1", { confirmed: true, consent: true, resumeFileId: upload.file.id });
  await db.query(
    "INSERT INTO student.calendar_events(user_id,created_by,title,kind,starts_at,ends_at) VALUES($1,$1,'Mock interview','interview',now()+interval '2 days',now()+interval '2 days 1 hour')",
    [ctx.users.s1],
  );

  await t.test("company FRIDAY sees its own drives; applicants only after release", async () => {
    const chat = await ok("POST", "/company/friday/conversations", "hrA", {});
    await ok("POST", `/company/friday/conversations/${chat.id}/message`, "hrA", { message: "Who are the candidates for my drive?" });
    let call = ai.calls.at(-1);
    assert.equal(call.kind, "company.chat");
    assert.equal(call.system, COMPANY_FRIDAY_SYSTEM);
    assert.match(call.system, /decline in one sentence/);
    const context = call.input.context;
    assert.equal(context.company.name, "Acme Systems");
    assert.deepEqual(context.drives.map((d) => [d.title, d.applicantsReleased, d.candidates]), [["Graduate Engineer", false, undefined]]);
    assert.equal(JSON.stringify(call.input).includes("Beta"), false, "nothing about company B");
    await ok("POST", `/placement/drives/${driveId}/release`, "officer", { release: true });
    await ok("POST", `/company/friday/conversations/${chat.id}/message`, "hrA", { message: "List the candidates and their contact email" });
    call = ai.calls.at(-1);
    assert.deepEqual(call.input.context.drives[0].candidates.map((c) => [c.usn, c.email]), [["C01", "c01@dsu.test"]]);
    const thread = await ok("GET", `/company/friday/conversations/${chat.id}`, "hrA");
    assert.equal(thread.messages.length, 4);
    // Company B cannot read or post to A's conversation, and its context has no A data.
    await fails(404, "GET", `/company/friday/conversations/${chat.id}`, "hrB");
    await fails(404, "POST", `/company/friday/conversations/${chat.id}/message`, "hrB", { message: "Show Acme's candidates" });
    const chatB = await ok("POST", "/company/friday/conversations", "hrB", {});
    await ok("POST", `/company/friday/conversations/${chatB.id}/message`, "hrB", { message: "Show me all candidates and every company's drives" });
    const inputB = JSON.stringify(ai.calls.at(-1).input);
    assert.equal(inputB.includes("Acme") || inputB.includes("C01") || inputB.includes("Graduate Engineer"), false);
    // Students and officers cannot use the company assistant.
    await fails(403, "POST", "/company/friday/conversations", "s1", {});
    await fails(403, "GET", "/company/friday/conversations", "officer");
  });

  await t.test("student FRIDAY sees only the student's own placement and schedule", async () => {
    const conversation = await ok("POST", "/student/conversations", "s1", { title: "Plans" });
    await ok("POST", `/student/conversations/${conversation.id}/message`, "s1", { message: "Do I have any schedule or pending work this week?" });
    const call = ai.calls.at(-1);
    assert.equal(call.kind, "chat.reply");
    const placement = call.input.myPlacement;
    assert.equal(placement.detail, "full");
    assert.deepEqual(placement.drives.map((d) => [d.company, d.title, d.my_application]), [["Acme Systems", "Graduate Engineer", "registered"]]);
    assert.deepEqual(placement.events.map((e) => e.title), ["Mock interview"]);
    assert.ok(placement.notices.some((n) => /New drive for you/.test(n.title)));
    assert.match(call.task, /Decline requests that are not about the student's own studies, career or placement/);
    const text = JSON.stringify(call.input);
    for (const secret of ["C02", "C03", "c03@dsu.test", "Beta", "hr@acme.test", "audience_mode"]) assert.equal(text.includes(secret), false, secret);
    // A student outside the audience gets no drive at all.
    const outside = await ok("POST", "/student/conversations", "s4", { title: "Plans" });
    await ok("POST", `/student/conversations/${outside.id}/message`, "s4", { message: "Which drives can I apply to?" });
    assert.deepEqual(ai.calls.at(-1).input.myPlacement.drives, []);
    // A general message gets counts only.
    await ok("POST", `/student/conversations/${conversation.id}/message`, "s1", { message: "Explain recursion simply" });
    assert.equal(ai.calls.at(-1).input.myPlacement.detail, "summary");
    assert.equal(ai.calls.at(-1).input.myPlacement.openDrives, 1);
    void ids;
  });
});
