import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { withActor } from "../src/integrations/supabase/db.js";
import { testDatabase } from "./helpers/database.js";
import { completeOnboarding } from "./helpers/onboarding.js";
import { makePdf } from "./helpers/pdf.js";
import { extractionResult, normalizeExtractedText } from "../src/modules/students/text-extraction.js";
import { driveJobDescription, driveTitle } from "../src/modules/students/drive-match.js";
import { normalizeDriveExtraction, DRIVE_FIELDS } from "../src/modules/portal/drive-intake.js";
import { responseSchema } from "../src/modules/students/chat.js";

const campusDay = (msAgo = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - msAgo));
const b64 = (value) => Buffer.from(value).toString("base64");
const RESUME =
  "Final-year CSE student. Projects: built a campus placement API in JavaScript and PostgreSQL with authorization tests; deployed it for 400 users. Skills: JavaScript, SQL, Git.";

test("Haki rejects filler answers while allowing concise real replies", () => {
  for (const text of ["placeholder", " Placeholder. ", "TODO", "Insert answer here", "   "])
    assert.equal(responseSchema.safeParse({ text, card: null }).success, false);
  assert.equal(responseSchema.safeParse({ text: "Start with a regression test.", card: null }).success, true);
});

test("extraction text is normalised and scanned PDFs are flagged", () => {
  assert.equal(
    normalizeExtractedText("Proﬁle\u0000 line\r\n\r\n\r\n\r\nnext  word​\t end  "),
    "Profile line\n\nnext word end",
  );
  // Page breaks, vertical tabs, NEL and Unicode line/paragraph separators stay line breaks.
  assert.equal(
    normalizeExtractedText("Skills\fJava\u000bSQL\u0085Git\u2028Linux\u2029Projects"),
    "Skills\nJava\nSQL\nGit\nLinux\nProjects",
  );
  const short = extractionResult("Scan  -- 1 --", 3);
  assert.deepEqual(
    { pageCount: short.pageCount, truncated: short.truncated, lowText: short.lowText },
    { pageCount: 3, truncated: false, lowText: true },
  );
  assert.equal(extractionResult("a".repeat(149), 3).lowText, true); // 50 letters per page
  assert.equal(extractionResult("a".repeat(150), 3).lowText, false);
  assert.equal(extractionResult("a".repeat(49), 1).lowText, true);
  // A scanner app's watermark on every page is not readable content.
  assert.equal(extractionResult("Scanned with CamScanner\n\nScanned with CamScanner", 2).lowText, true);
  assert.equal(extractionResult("short text", null).lowText, false); // only PDFs have pages
  const long = extractionResult("word ".repeat(20000), 2);
  assert.equal(long.truncated, true);
  assert.equal(long.content.length, 80000);
  assert.equal(long.chars, 99999);
});

test("drive JD text and intake normalisation use only real values", () => {
  const jd = driveJobDescription({
    company: "Acme", title: "Analyst", package_lpa: "6", min_cgpa: "7", max_backlogs: 0,
    branches: [], rounds: ["Test", "HR"], skills: "SQL", description: "", location: null, employment_type: "internship-ppo",
  });
  assert.match(jd, /^Company: Acme\nRole: Analyst\nEmployment type: Internship with pre-placement offer\nPackage \(LPA\): 6/);
  assert.match(jd, /Maximum current backlogs: 0/);
  assert.match(jd, /Permitted branches: All branches/);
  assert.match(jd, /Selection rounds \(in order\): Test → HR/);
  assert.doesNotMatch(jd, /Location|Job description/);
  assert.equal(driveTitle({ company: "Acme" }), "Eligibility · Acme");
  const empty = normalizeDriveExtraction({});
  assert.deepEqual(empty.missingFields, DRIVE_FIELDS);
  assert.deepEqual(empty.warnings, []);
  const checked = normalizeDriveExtraction({
    drive_date: "2026-11-10", registration_deadline: "2026-11-12", openings: 2.5, package_lpa: -1, employment_type: "Freelance",
  });
  assert.equal(checked.fields.openings, null);
  assert.equal(checked.fields.package_lpa, null);
  assert.equal(checked.fields.employment_type, "");
  assert.ok(checked.warnings.some((w) => /after the drive date/.test(w)));
});

test("Observation Haki research, drive comparison, parsers, career history, dashboard and drive intake", { timeout: 120000 }, async (t) => {
  const { db, pool } = await testDatabase();
  const users = { a: randomUUID(), b: randomUUID(), officer: randomUUID(), officer2: randomUUID() };
  const students = { a: randomUUID(), b: randomUUID() };
  await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [Object.values(users)]);
  for (const [key, batch] of [["a", "2027"], ["b", "2029"]]) {
    await db.query(
      "INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name) VALUES($1,$2,$3,$4,$5,'CSE')",
      [students[key], "USN-" + key, "Student " + key, batch, key],
    );
    await db.query("INSERT INTO erp.academics(student_id,cgpa,current_backlog,attendance) VALUES($1,8.2,0,90)", [students[key]]);
    await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [users[key], students[key]]);
    await completeOnboarding(db, students[key]);
  }
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1),($2)", [users.officer, users.officer2]);

  const aiCalls = [];
  const ai = async ({ kind, input, task }) => {
    const ledger = (await db.query("SELECT kind,status FROM student.ai_requests ORDER BY created_at")).rows;
    aiCalls.push({ kind, input, ledger, task });
    await db.exec("DELETE FROM student.ai_requests");
    if (kind === "chat.reply")
      return { text: "## Outlook\n- Hiring is active.", card: null, citations: [1, 9, -1, 1] };
    if (kind === "chat.jd-match")
      return {
        text: "## Verdict\nYou match most requirements.",
        card: {
          type: "jd-match", title: "Acme Systems requirements", summary: "Advisory comparison.", score: null,
          items: [
            { label: "JavaScript", description: "Campus placement API project.", status: "strong" },
            { label: "Testing", description: "Authorization tests only.", status: "partial" },
          ],
          actions: ["Add a testing example"],
        },
        citations: [0],
      };
    if (kind === "career.analyze")
      return {
        summary: "Report for " + input.target, advice: "Add outcomes.", alignment: null, atsHealth: null, bestFit: input.target,
        signals: [], strengths: [], weaknesses: [], roadmap: [], risks: [],
        roles: [{ title: input.target, fit: null, reason: "Stated target" }],
        recommendations: [], missingKeywords: [], formattingIssues: [],
        profile: { academics: ["B.Tech CSE"], skills: ["JavaScript", "SQL"], projects: ["Campus placement API"], achievements: [] },
      };
    if (kind === "officer.drive.parse")
      return {
        company_name: "Acme Systems", title: "Graduate Engineer", package_lpa: 8, location: "Bengaluru",
        drive_date: "2026-11-20", registration_deadline: "2026-11-31", min_cgpa: 65, max_backlogs: 0,
        branches: ["CSE", "ISE", "CSE"], skills: "JavaScript, SQL", description: "Build services.",
        rounds: ["Aptitude", "Technical", "HR"], required_documents: "", job_category: "Software / IT",
        employment_type: "Full-Time", openings: null, contact: "hr@acme.example", notes: ["CTC is stated as a range."],
      };
    throw Error("Unexpected AI request " + kind);
  };
  const searches = [];
  const results = [
    { title: "Acme campus hiring", url: "https://acme.example/campus", description: "Three rounds." },
    { title: "Acme interview guide", url: "https://guide.example/acme", description: "Technical round topics." },
  ];
  const research = {
    enabled: true,
    search: async (query, count) => {
      searches.push({ query, count });
      return { status: "ok", provider: "brave", cached: false, results };
    },
    close: async () => {},
  };
  const app = await buildApp({
    pool,
    env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 10000 },
    logger: false,
    verify: async (token) => ({ id: users[token] }),
    studentAi: ai,
    research,
  });
  t.after(() => app.close());
  async function call(path, body, user = "a", expected = 200) {
    const response = await app.inject({
      url: "/api/v1" + path,
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + user },
      payload: body,
    });
    assert.equal(response.statusCode, expected, path + ": " + response.body);
    return response.json();
  }
  const data = async (...args) => (await call(...args)).data;
  const act = (action, payload) =>
    data("/placement/actions/" + action, { payload, requestId: randomUUID() }, "officer");

  const company = await act("company.save", { name: "Acme Systems", industry: "IT services" });
  const drive = await act("drive.save", {
      company_id: company.id, title: "Graduate engineer", package_lpa: "8", academic_year: "2026-27", batch: "2027",
      min_cgpa: "7", max_backlogs: "0", rounds: ["Aptitude", "Technical", "HR"], skills: "JavaScript, Testing",
      description: "Build and test backend services.", location: "Bengaluru", published: true,
    });

  await t.test("a drive comparison asks for a resume before analysing", async () => {
    const thread = await data("/student/conversations", { driveId: drive.id });
    assert.equal(thread.title, "Eligibility · Acme Systems");
    await call("/student/conversations", { driveId: drive.id }, "b", 404); // other batch: not visible
    const before = aiCalls.length;
    const reply = await data(`/student/conversations/${thread.id}/message`, { message: "Compare my profile with this JD" });
    assert.equal(reply.needsResume, true);
    assert.equal(reply.research, "skipped");
    assert.match(reply.text, /no resume/);
    assert.match(reply.text, /meet this drive's published criteria/);
    assert.equal(aiCalls.length, before);
    assert.equal(searches.length, 0);
    const saved = await data(`/student/conversations/${thread.id}`);
    assert.equal(saved.messages.length, 2);
    assert.deepEqual(saved.drive, { id: drive.id, title: "Graduate engineer", company: "Acme Systems" });

    const resume = await data("/student/documents", { filename: "resume.txt", kind: "resume", data: b64(RESUME) });
    assert.deepEqual(
      { pageCount: resume.pageCount, truncated: resume.truncated, lowText: resume.lowText, chars: resume.chars },
      { pageCount: null, truncated: false, lowText: false, chars: RESUME.length },
    );
    const match = await data(`/student/conversations/${thread.id}/message`, { message: "Compare my profile with this JD" });
    const request = aiCalls.at(-1);
    assert.equal(request.kind, "chat.jd-match");
    assert.match(request.input.jd, /Company: Acme Systems\nRole: Graduate engineer/);
    assert.match(request.input.jd, /Required skills: JavaScript, Testing/);
    assert.match(request.input.jd, /Minimum CGPA: 7/);
    assert.equal(request.input.officialEligibility.eligible, true);
    assert.equal(request.input.resume, RESUME);
    assert.equal(request.input.resumeOrigin, "latest-upload");
    assert.equal(request.input.research.length, 2);
    assert.equal(request.input.research[0].url, undefined); // the model gets no URLs
    assert.match(searches[0].query, /^Acme Systems Graduate engineer/);
    assert.ok(request.ledger.some((row) => row.kind === "research.web" && row.status === "completed"));
    assert.equal(match.card.type, "jd-match");
    assert.equal(match.research, "used");
    assert.deepEqual(match.sources.map((s) => s.url), ["https://acme.example/campus"]);
    const stored = await data(`/student/conversations/${thread.id}`);
    assert.equal(stored.messages.at(-1).card.items[1].status, "partial");
    assert.equal(stored.messages.at(-1).sources[0].domain, "acme.example");
    const quiet = await data(`/student/conversations/${thread.id}/message`, { message: "Shorter plan", webSearch: false });
    assert.equal(quiet.research, "off");
    assert.equal(searches.length, 1);
  });

  await t.test("web search is opt-in, cited by index and honest when unavailable", async () => {
    assert.deepEqual(await data("/student/assistant/status"), { chatReady: true, researchReady: true });
    const thread = await data("/student/conversations", { title: "Market check" });
    const plain = await data(`/student/conversations/${thread.id}/message`, { message: "Is Acme hiring?" });
    assert.equal(plain.research, "off");
    assert.deepEqual(aiCalls.at(-1).input.research, []);
    assert.equal(aiCalls.at(-1).input.currentDate, campusDay());
    assert.equal(aiCalls.at(-1).input.timeZone, "Asia/Kolkata");
    assert.match(aiCalls.at(-1).task, /blank line between paragraphs/);
    assert.match(aiCalls.at(-1).task, /each numbered or '- ' bulleted item on its own line/);
    assert.equal(aiCalls.at(-1).input.resume, RESUME, "ordinary chat includes the student's saved resume");
    assert.equal(aiCalls.at(-1).input.resumeOrigin, "latest-upload");
    assert.equal(searches.length, 1);
    const searched = await data(`/student/conversations/${thread.id}/message`, { message: "Is Acme hiring?", webSearch: true });
    assert.equal(searches.at(-1).query, "Is Acme hiring?");
    assert.equal(searched.research, "used");
    assert.equal(searched.researchInfo.query, "Is Acme hiring?");
    assert.equal(searched.researchInfo.resultCount, 2);
    assert.equal(searched.researchInfo.results.length, 2);
    assert.equal(aiCalls.at(-1).input.researchStatus, "used");
    assert.match(aiCalls.at(-1).task, /a real web search has completed/);
    // Citations [1, 9, -1, 1]: only the in-range, first occurrence becomes a source.
    assert.deepEqual(searched.sources, [
      { title: "Acme interview guide", url: "https://guide.example/acme", description: "Technical round topics.", domain: "guide.example" },
    ]);
    research.enabled = false;
    const unavailable = await data(`/student/conversations/${thread.id}/message`, { message: "Is Acme hiring?", webSearch: true });
    research.enabled = true;
    assert.equal(unavailable.research, "unavailable");
    assert.deepEqual(unavailable.sources, []);
    assert.equal(searches.length, 2);
    // Searches use the same per-student request budget as AI calls.
    await db.query("INSERT INTO student.ai_requests(user_id,kind,status) SELECT $1,'chat.reply','completed' FROM generate_series(1,12)", [users.a]);
    const limited = await call(`/student/conversations/${thread.id}/message`, { message: "Again", webSearch: true }, "a", 429);
    assert.equal(limited.error.code, "AI_RATE_LIMIT");
    assert.equal(searches.length, 2);
    await db.exec("DELETE FROM student.ai_requests");
    await call(`/student/conversations/${thread.id}/message`, { message: "x", webSearch: "yes" }, "a", 400);
    // Without an AI provider the answer can't be produced, so no paid search is made.
    const noAi = await buildApp({
      pool: { ...pool, end: async () => {} },
      env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 10000 },
      logger: false,
      verify: async (token) => ({ id: users[token] }),
      research,
    });
    try {
      const status = await noAi.inject({ url: "/api/v1/student/assistant/status", headers: { authorization: "Bearer a" } });
      assert.deepEqual(status.json().data, { chatReady: false, researchReady: true });
      const response = await noAi.inject({
        url: `/api/v1/student/conversations/${thread.id}/message`,
        method: "POST",
        headers: { authorization: "Bearer a" },
        payload: { message: "Is Acme hiring?", webSearch: true },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, "AI_NOT_CONFIGURED");
      assert.equal(searches.length, 2);
    } finally {
      await noAi.close();
    }
  });

  await t.test("conversations stay private and drives follow the opportunity listing's visibility", async () => {
    const thread = await data("/student/conversations", { driveId: drive.id });
    const before = { ai: aiCalls.length, searches: searches.length };
    await call(`/student/conversations/${thread.id}/message`, { message: "Compare", webSearch: true }, "b", 404);
    await call(`/student/conversations/${thread.id}/delete`, {}, "b");
    assert.equal((await data(`/student/conversations/${thread.id}`)).id, thread.id); // still there
    assert.deepEqual({ ai: aiCalls.length, searches: searches.length }, before);
    // A draft drive is not listed for students, so it can't be compared either.
    const draft = await act("drive.save", {
      company_id: company.id, title: "Data analyst", package_lpa: "6", academic_year: "2026-27", batch: "2027",
      min_cgpa: "6", max_backlogs: "0", rounds: ["Interview"], description: "Analyse data.", published: false,
    });
    assert.ok(!(await data("/student/opportunities")).rows.some((row) => row.id === draft.id));
    await call(`/student/opportunities/${draft.id}`, undefined, "a", 404);
    await call("/student/conversations", { driveId: draft.id }, "a", 404);
    // A drive that stops being visible ends its comparison honestly.
    const later = await act("drive.save", {
      company_id: company.id, title: "Support engineer", package_lpa: "5", academic_year: "2026-27", batch: "2027",
      min_cgpa: "6", max_backlogs: "0", rounds: ["Interview"], description: "Support customers.", published: true,
    });
    const hidden = await data("/student/conversations", { driveId: later.id });
    await db.query("UPDATE placement.drives SET published=false WHERE id=$1", [later.id]);
    assert.equal((await data(`/student/conversations/${hidden.id}`)).drive, null);
    const gone = await call(`/student/conversations/${hidden.id}/message`, { message: "Compare" }, "a", 404);
    assert.equal(gone.error.code, "NOT_FOUND");
    assert.deepEqual({ ai: aiCalls.length, searches: searches.length }, before);
  });

  await t.test("PDF uploads report pages, characters and the scanned heuristic", async () => {
    const scanned = await data("/student/documents", { filename: "scan.pdf", kind: "attachment", data: makePdf(["Page 1"]).toString("base64") });
    assert.deepEqual(
      { pageCount: scanned.pageCount, lowText: scanned.lowText, truncated: scanned.truncated },
      { pageCount: 1, lowText: true, truncated: false },
    );
    const lines = Array.from({ length: 8 }, (_, i) => `Responsibility ${i + 1}: design, build and test reliable services`);
    const text = await data("/student/documents", { filename: "jd.pdf", kind: "jd", data: makePdf(lines).toString("base64") });
    assert.equal(text.lowText, false);
    assert.equal(text.content.split("\n")[0], lines[0]);
    assert.ok(!/-- 1 of 1 --/.test(text.content));
    const meta = (await db.query("SELECT meta FROM student.documents WHERE id=$1", [text.id])).rows[0].meta;
    assert.deepEqual(meta, { pageCount: 1, chars: text.chars, truncated: false, lowText: false });
    // Deliberate limits say what was exceeded instead of "could not be read".
    const tooLong = await call("/student/documents", { filename: "book.pdf", kind: "attachment", data: makePdf(["Chapter"], 101).toString("base64") }, "a", 413);
    assert.equal(tooLong.error.code, "TOO_MANY_PAGES");
    const pages = await data("/student/documents", { filename: "two.pdf", kind: "jd", data: makePdf(lines, 2).toString("base64") });
    assert.equal(pages.pageCount, 2);
    assert.equal(pages.content.split("\n\n").length, 2); // one blank line between pages, no markers
  });

  let reports;
  await t.test("career reports keep a private, structured history", async () => {
    await data("/student/career", { resume: RESUME, target: "Graduate engineer", consent: true });
    const second = await data("/student/career", { resume: RESUME, target: "Data analyst", consent: true });
    assert.deepEqual(second.content.profile.skills, ["JavaScript", "SQL"]);
    assert.match(aiCalls.at(-1).input.target, /Data analyst/);
    reports = await data("/student/career/reports");
    assert.deepEqual(reports.map((r) => r.target), ["Data analyst", "Graduate engineer"]);
    assert.equal(reports[0].best_fit, "Data analyst");
    assert.deepEqual(await data("/student/career/reports", undefined, "b"), []);
    const own = await data("/student/career/reports/" + reports[1].id);
    assert.equal(own.target, "Graduate engineer");
    assert.deepEqual(own.content.profile.projects, ["Campus placement API"]);
    await call("/student/career/reports/" + reports[1].id, undefined, "b", 404);
    await call("/student/career/reports/not-a-uuid", undefined, "a", 400);
    const plan = (await db.query("INSERT INTO student.reports(user_id,kind,content) VALUES($1,'readiness-plan','{}') RETURNING id", [users.a])).rows[0];
    await call("/student/career/reports/" + plan.id, undefined, "a", 404);
  });

  await t.test("dashboard shows activity per day and real pipeline counts", async () => {
    await db.query(
      "INSERT INTO student.activity(user_id,kind,created_at) VALUES($1,'interview.completed',now()-interval '3 days'),($1,'assessment.completed',now()-interval '3 days'),($1,'interview.completed',now()-interval '5 days'),($1,'placement.applied',now()-interval '5 days')",
      [users.a],
    );
    const dashboard = await data("/student/dashboard");
    const counts = Object.fromEntries(dashboard.activity.map((row) => [row.day, row.count]));
    assert.equal(counts[campusDay()], 2); // two resume reports today
    assert.equal(counts[campusDay(3 * 86400000)], 2);
    assert.equal(counts[campusDay(5 * 86400000)], 1); // applications are not preparation activity
    assert.deepEqual(dashboard.activityDates, dashboard.activity.map((row) => row.day));
    assert.deepEqual(dashboard.pipeline, { registered: 0, inProgress: 0, selected: 0, placed: 0, rejected: 0, total: 0 });
    await data(`/student/opportunities/${drive.id}/apply`, { confirmed: true, consent: true });
    assert.equal((await data("/student/dashboard")).pipeline.registered, 1);
    await db.query("UPDATE placement.registrations SET status='placed' WHERE drive_id=$1", [drive.id]);
    assert.deepEqual((await data("/student/dashboard")).pipeline, { registered: 0, inProgress: 0, selected: 0, placed: 1, rejected: 0, total: 1 });
  });

  await t.test("officers import a drive PDF as reviewable suggestions only", async () => {
    const pdf = makePdf([
      "Acme Systems campus drive",
      "Role: Graduate Engineer. CTC 8 LPA. Location: Bengaluru",
      "Eligible branches: CSE, ISE. Rounds: Aptitude, Technical, HR",
      "Contact: hr@acme.example",
    ]).toString("base64");
    await call("/placement/drives/parse", { filename: "drive.pdf", data: pdf }, "a", 403);
    await call("/placement/drives/parse", { filename: "drive.pdf", data: b64("not a pdf") }, "officer", 400);
    await call("/placement/drives/parse", { filename: "drive.txt", data: pdf }, "officer", 400);
    await call("/placement/drives/parse", { filename: "drive.pdf", data: "A".repeat(14 * 1024 * 1024) }, "officer", 413);
    const drivesBefore = (await db.query("SELECT count(*)::int n FROM placement.drives")).rows[0].n;
    const parsed = await data("/placement/drives/parse", { filename: "drive.pdf", data: pdf }, "officer");
    assert.equal(aiCalls.at(-1).kind, "officer.drive.parse");
    assert.match(aiCalls.at(-1).input.documentText, /Acme Systems campus drive/);
    assert.equal(parsed.fields.company_name, "Acme Systems");
    assert.equal(parsed.fields.package_lpa, 8);
    assert.equal(parsed.fields.registration_deadline, ""); // 2026-11-31 is not a date
    assert.equal(parsed.fields.min_cgpa, null); // 65 is not a 10-point CGPA
    assert.equal(parsed.fields.employment_type, "full-time");
    assert.deepEqual(parsed.fields.branches, ["CSE", "ISE"]);
    assert.deepEqual(
      parsed.missingFields,
      ["registration_deadline", "min_cgpa", "required_documents", "openings"],
    );
    assert.ok(parsed.warnings.some((w) => /Registration deadline "2026-11-31"/.test(w)));
    assert.ok(parsed.warnings.some((w) => /Minimum CGPA "65"/.test(w)));
    assert.ok(parsed.warnings.includes("CTC is stated as a range."));
    assert.equal(parsed.document.stored, "text-only");
    assert.equal((await db.query("SELECT count(*)::int n FROM placement.drives")).rows[0].n, drivesBefore);
    const intake = (await db.query("SELECT created_by,filename,low_text,extracted FROM placement.drive_intakes WHERE id=$1", [parsed.intakeId])).rows[0];
    assert.equal(intake.created_by, users.officer);
    assert.equal(intake.extracted.title, "Graduate Engineer");
    const visible = (who) =>
      withActor(pool, users[who], async (client) => (await client.query("SELECT count(*)::int n FROM placement.drive_intakes")).rows[0].n);
    assert.equal(await visible("a"), 0);
    assert.equal(await visible("officer"), 1);
    // Students can't write intakes, officers can't attribute them to someone
    // else, and stored intakes are append-only for the runtime role.
    const insert = (who, createdBy) =>
      withActor(pool, users[who], (client) =>
        client.query(
          "INSERT INTO placement.drive_intakes(created_by,filename,sha256,chars,content) VALUES($1,'x.pdf',$2,0,'')",
          [createdBy, "0".repeat(64)],
        ),
      );
    await assert.rejects(insert("a", users.a));
    await assert.rejects(insert("officer", users.a));
    await assert.rejects(
      withActor(pool, users.officer, (client) => client.query("UPDATE placement.drive_intakes SET content=''")),
    );

    // The AI reads the first 40,000 characters; a longer notice says so.
    // (A second officer: the parse route allows five requests a minute.)
    const longLines = Array.from(
      { length: 40 },
      (_, i) => `Clause ${String(i).padStart(2, "0")}: responsibilities, eligibility and the selection process for this role`,
    );
    const long = await data("/placement/drives/parse", { filename: "long.pdf", data: makePdf(longLines, 20).toString("base64") }, "officer2");
    assert.ok(long.document.chars > 40000 && !long.document.truncated);
    assert.equal(aiCalls.at(-1).input.documentText.length, 40000);
    assert.ok(long.warnings.some((w) => /Only the first part/.test(w)));

    const before = aiCalls.length;
    const scanned = await data("/placement/drives/parse", { filename: "scan.pdf", data: makePdf(["CTC"]).toString("base64") }, "officer");
    assert.equal(aiCalls.length, before); // nothing to read: no AI call, no guesses
    assert.deepEqual(scanned.missingFields, DRIVE_FIELDS);
    assert.match(scanned.warnings[0], /scanned/);
  });
});
