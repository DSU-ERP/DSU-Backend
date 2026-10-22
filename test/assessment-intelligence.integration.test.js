import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { testDatabase } from "./helpers/database.js";
import {
  CATEGORIES,
  practiceFormat,
  practiceQuestions,
} from "../src/modules/students/practice-bank.js";
import {
  answerRelease,
  capIntegrity,
  insightProblems,
  integritySummary,
  presentResult,
  questionSchema,
  sectionBreakdown,
  validateQuestions,
} from "../src/modules/students/assessments.js";
import { checkDrafts } from "../src/modules/students/officer-tools.js";

const KEYS = ["correctIndex", "expectedPoints", "explanation", "expected", "feedback", "score", "state"];
// Derived from per-question marks, so withheld with the key.
const SECTION_FIELDS = ["sections", "strengths", "weaknesses", "recommendations"];

test("seeded practice papers vary by seed, rebuild exactly and keep valid keys", () => {
  for (const category of Object.keys(CATEGORIES))
    for (let level = 1; level <= 5; level++) {
      const format = practiceFormat(category, level);
      const papers = [11, 12, 13, 14].map((seed) => practiceQuestions(category, level, seed));
      assert.deepEqual(practiceQuestions(category, level, 11), papers[0], "same seed rebuilds the same paper");
      assert.ok(
        new Set(papers.map((paper) => JSON.stringify(paper))).size >= 3,
        `${category} L${level} should vary across seeds`,
      );
      for (const paper of papers) {
        assert.equal(paper.length, format.questions);
        assert.equal(paper.filter((q) => q.type === "short").length, format.written);
        assert.equal(new Set(paper.map((q) => q.question)).size, paper.length, "no repeated question in a paper");
        // Same validators as saved assessments; throws on any invalid key.
        validateQuestions(paper.map(({ id: _id, ...q }) => questionSchema.parse(q)));
        for (const q of paper)
          if (q.type === "mcq") {
            assert.equal(q.options.length, 4);
            assert.equal(new Set(q.options).size, 4);
            assert.ok(q.correctIndex >= 0 && q.correctIndex < 4);
            assert.doesNotMatch(q.options.join(" "), /NaN|undefined|Infinity|None of the other/);
          } else assert.ok(q.expectedPoints.length >= 3);
      }
    }
  // Option order is shuffled, not fixed by position.
  const positions = new Set();
  for (let seed = 0; seed < 30; seed++)
    for (const q of practiceQuestions("management-basics", 1, seed)) positions.add(q.correctIndex);
  assert.equal(positions.size, 4);
  // Case analysis covers its three named case types, beyond break-even reuse.
  const sections = new Set();
  for (let seed = 0; seed < 10; seed++)
    for (const q of practiceQuestions("case-analysis", 3, seed)) sections.add(q.section);
  for (const name of ["Market sizing", "Profitability", "Pricing"]) assert.ok(sections.has(name), name);
  for (const category of ["business-communication", "management-basics"])
    for (let level = 1; level <= 5; level++)
      assert.ok(practiceQuestions(category, level, 5).filter((q) => q.type === "mcq").length >= 6);
  assert.equal(practiceFormat("management-basics", 4).written, 1);
  assert.equal(practiceFormat("aptitude", 5).written, 0);
  // Without an AI provider no paper carries an item only AI can grade.
  for (const category of Object.keys(CATEGORIES))
    for (let level = 1; level <= 5; level++) {
      const format = practiceFormat(category, level, { written: false });
      assert.equal(format.written, 0);
      for (const seed of [3, 4]) {
        const paper = practiceQuestions(category, level, seed, { written: false });
        assert.equal(paper.length, format.questions);
        assert.ok(paper.every((q) => q.type === "mcq"), `${category} L${level} is objective-only`);
      }
    }
  assert.deepEqual(practiceFormat("business-communication", 3, { written: false }), { questions: 6, written: 0, durationMinutes: 14 });
});

test("pure helpers: severity, release policy, withheld review, sections and insight citations", () => {
  assert.deepEqual(
    integritySummary([{ kind: "clipboard" }, { kind: "fullscreen-exit" }, { kind: "tab-hidden" }, { kind: "inactive" }, { kind: "window-blur" }]),
    { total: 5, high: 2, medium: 2, low: 1 },
  );
  const closes = new Date(Date.now() + 3600000).toISOString();
  assert.equal(answerRelease({ kind: "assigned", closes_at: closes, config: {} }).withheld, true);
  assert.equal(answerRelease({ kind: "assigned", closes_at: closes, config: { revealAnswers: "immediately" } }).withheld, false);
  assert.equal(answerRelease({ kind: "assigned", closes_at: new Date(Date.now() - 1000), config: {} }).withheld, false);
  assert.equal(answerRelease({ kind: "practice", closes_at: null, config: {} }).withheld, false);
  // Released exactly when server time reaches closes_at, never earlier.
  const at = Date.parse(closes);
  assert.equal(answerRelease({ kind: "assigned", closes_at: closes, config: {} }, at - 1).withheld, true);
  assert.equal(answerRelease({ kind: "assigned", closes_at: closes, config: {} }, at).withheld, false);
  const review = [
    { id: "q1", section: "A", type: "mcq", marks: 2, score: 2, state: "correct", correctIndex: 1, expected: "Four", explanation: "x", feedback: "x", answer: "1", question: "Q1?" },
    { id: "q2", section: "A", type: "mcq", marks: 2, score: 0, state: "incorrect", correctIndex: 0, expected: "One", explanation: "y", feedback: "y", answer: "1", question: "Q2?" },
    { id: "q3", section: "B", type: "short", marks: 3, score: 1.5, state: "partial", expectedPoints: ["p"], expected: "p", explanation: "", feedback: "z", answer: "text", question: "Q3?" },
  ];
  assert.deepEqual(sectionBreakdown(review), [
    { name: "A", score: 2, maximum: 4, questions: 2, correct: 1, percentage: 50 },
    { name: "B", score: 1.5, maximum: 3, questions: 1, correct: 0, percentage: 50 },
  ]);
  // A legacy result: no sections, no severity on its events.
  const legacy = { score: 3.5, maximum: 7, percentage: 50, correct: 1, strengths: ["A"], weaknesses: ["A", "B"], recommendations: ["Help me practise A"], review, integrity: [{ kind: "clipboard" }] };
  const shown = presentResult(legacy, { withheld: false, releaseAt: closes });
  assert.equal(shown.sections.length, 2, "legacy results gain a section breakdown");
  assert.equal(shown.integrity[0].severity, "high");
  assert.deepEqual(shown.weaknesses, ["A", "B"]);
  const hidden = presentResult(legacy, { withheld: true, releaseAt: closes });
  assert.equal(hidden.answersWithheld, true);
  assert.equal(hidden.highRisk, 1);
  // Section B has one question: its marks would reveal that question's result.
  for (const key of SECTION_FIELDS) assert.equal(hidden[key], undefined, key);
  assert.deepEqual([hidden.score, hidden.maximum, hidden.percentage, hidden.correct], [3.5, 7, 50, 1], "totals stay visible");
  for (const q of hidden.review) for (const key of KEYS) assert.equal(q[key], undefined, key);
  assert.equal(hidden.review[0].answer, "1");
  // A burst of low-severity events never evicts a high-risk one.
  const burst = [{ kind: "clipboard", at: "t0" }, ...Array.from({ length: 200 }, (_, i) => ({ kind: i % 2 ? "window-blur" : "tab-hidden", at: "t" + (i + 1) }))];
  const capped = capIntegrity(burst);
  assert.equal(capped.length, 200);
  assert.equal(capped[0].kind, "clipboard");
  assert.equal(capped.filter((event) => event.kind === "window-blur").length, 99, "the oldest low event goes first");
  assert.deepEqual(capIntegrity(burst.slice(0, 3)), burst.slice(0, 3));
  const ok = { strengths: [{ text: "Accurate", questionIds: ["q1", "q3"] }], weaknesses: [{ text: "Missed", questionIds: ["q2", "q3"] }], suggestions: [{ text: "Practise", questionIds: ["q2"] }] };
  assert.deepEqual(insightProblems(ok, review), []);
  assert.equal(insightProblems({ ...ok, suggestions: [{ text: "Unknown", questionIds: ["q9"] }] }, review).length, 1);
  assert.equal(insightProblems({ ...ok, strengths: [{ text: "Wrong", questionIds: ["q2"] }] }, review).length, 1);
  assert.equal(insightProblems({ ...ok, weaknesses: [{ text: "Right", questionIds: ["q1"] }] }, review).length, 1);
  const input = { topic: "Ratios", count: 1, marks: 2, questionType: "mcq" };
  const mcq = { section: "x", type: "mcq", question: "What is 2:4 in simplest form?", options: ["1:2", "2:1"], correctIndex: 0, expectedPoints: [], marks: 1, explanation: "Divide by 2." };
  assert.deepEqual(checkDrafts(input, [mcq]), [{ ...mcq, section: "Ratios", marks: 2 }]);
  assert.equal(checkDrafts(input, [{ ...mcq, options: ["1:2", " 1:2 "] }]), null);
  assert.equal(checkDrafts(input, [{ ...mcq, correctIndex: 3 }]), null);
  assert.equal(checkDrafts(input, [{ ...mcq, type: "short", options: [], correctIndex: null, expectedPoints: ["Halve both"] }]), null);
});

test("assessment intelligence over the API", { timeout: 120000 }, async (t) => {
  const { db, pool } = await testDatabase();
  const users = { a: randomUUID(), b: randomUUID(), officer: randomUUID(), cell: randomUUID() };
  await db.query("INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,'a@dsu.edu.in','{}'),($2,'b@dsu.edu.in','{}'),($3,'kavya.rao@dsu.edu.in',$5),($4,'placement.cell@dsu.edu.in','{}')", [users.a, users.b, users.officer, users.cell, JSON.stringify({ full_name: "Dr. Kavya Rao" })]);
  const students = [randomUUID(), randomUUID()];
  for (const [i, user] of ["a", "b"].entries()) {
    await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash) VALUES($1,$2,$3,$4,$5)", [students[i], "AI00" + i, "Student " + user, i ? "2029" : "2028", "h" + user]);
    await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [users[user], students[i]]);
  }
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1),($2)", [users.officer, users.cell]);
  const calls = [];
  let insightsOutput = null, draftOutput = null, gradingDown = false;
  const ai = async ({ kind, input }) => {
    await db.exec("DELETE FROM student.ai_requests");
    calls.push(kind);
    if (kind === "assessment.evaluate") {
      if (gradingDown) throw Error("simulated provider outage");
      return { results: input.questions.map((q) => ({ id: q.id, score: q.maximum / 2, feedback: "Name a measured outcome." })) };
    }
    if (kind === "assessment.insights") return insightsOutput(input);
    if (kind === "officer.assessment.generate") return draftOutput(input);
    throw Error("Unexpected AI request " + kind);
  };
  const app = await buildApp({
    pool,
    env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 10000, ASSESSMENT_CODE_SECRET: "c".repeat(32) },
    logger: false,
    verify: async (token) => ({ id: users[token] }),
    studentAi: ai,
  });
  t.after(() => app.close());
  async function request(path, body, user = "a", expected = 200) {
    const response = await app.inject({ url: "/api/v1" + path, method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + user }, payload: body });
    assert.equal(response.statusCode, expected, path + ": " + response.body);
    return response.json().data ?? response.json().error;
  }
  const mcq = (question, options, correctIndex, section = "Reasoning") => ({ section, type: "mcq", question, options, correctIndex, expectedPoints: [], marks: 2, explanation: "Worked solution." });
  const assigned = (extra = {}) => ({
    title: "Assigned reasoning check",
    className: "Graduate cohort",
    portions: "Ratios, series, written evidence",
    questions: [
      mcq("Which number equals two plus two?", ["Three", "Four"], 1),
      mcq("Which number is even?", ["Two", "Three"], 0),
      { section: "Writing", type: "short", question: "Explain a project outcome.", options: [], correctIndex: null, expectedPoints: ["Outcome evidence", ""], marks: 2, explanation: "" },
    ],
    batch: "2028",
    opensAt: new Date(Date.now() - 60000).toISOString(),
    closesAt: new Date(Date.now() + 3600000).toISOString(),
    durationMinutes: 30,
    proctored: true,
    published: true,
    ...extra,
  });
  let attemptId, testId;

  await t.test("practice papers are server-seeded, stored and resumed with the same paper", async () => {
    assert.equal((await request("/student/practice/case-analysis/1", { seed: 7 }, "a", 400)).code, "VALIDATION_ERROR", "a client cannot choose the seed");
    const first = await request("/student/practice/case-analysis/1", {});
    assert.equal(first.resumed, false);
    assert.equal((await request("/student/practice/case-analysis/1", {})).id, first.id, "an unstarted paper is reused, not stored again");
    const attempt = await request(`/student/assessments/${first.id}/start`, { accepted: true });
    const opened = await request(`/student/attempts/${attempt.id}`);
    assert.deepEqual([opened.kind, opened.category, opened.level], ["practice", "case-analysis", 1]);
    const paperShown = opened.questions;
    // Reopening the level resumes the unfinished attempt on the same paper.
    assert.deepEqual(await request("/student/practice/case-analysis/1", {}), { id: first.id, resumed: true });
    const resumed = await request(`/student/assessments/${first.id}/start`, { accepted: true });
    assert.deepEqual([resumed.id, resumed.resumed], [attempt.id, true]);
    assert.deepEqual((await request(`/student/attempts/${attempt.id}`)).questions, paperShown);
    let listing = await request("/student/practice");
    assert.deepEqual(listing.active, [{ category: "case-analysis", level: 1, attempt: attempt.id }]);
    await request(`/student/attempts/${attempt.id}/submit`, { answers: {} });
    // A finished paper is never redrawn into the next one: a new seed is drawn.
    const second = await request("/student/practice/case-analysis/1", {});
    assert.notEqual(second.id, first.id);
    const rows = (await db.query("SELECT config,questions FROM student.assessments WHERE id=ANY($1::uuid[]) ORDER BY created_at", [[first.id, second.id]])).rows;
    assert.ok(Number.isInteger(rows[0].config.seed) && rows[0].config.seed > 0);
    assert.notEqual(rows[0].config.seed, rows[1].config.seed);
    assert.notDeepEqual(rows[0].questions, rows[1].questions);
    assert.deepEqual(rows[0].questions, practiceQuestions("case-analysis", 1, rows[0].config.seed));
    listing = await request("/student/practice");
    assert.deepEqual(listing.active, []);
    assert.equal(listing.levels[0], "Foundation");
    assert.deepEqual(listing.formats["case-analysis"][2], { level: 3, ...practiceFormat("case-analysis", 3) });
    assert.equal(listing.formats["business-communication"][2].written, 1, "written items appear when AI is configured");
  });

  await t.test("assigned unlock shows difficulty, release policy and the author's name", async () => {
    await request("/placement/tools/assessments", { ...assigned(), difficulty: "expert" }, "officer", 400);
    const created = await request("/placement/tools/assessments", { ...assigned(), difficulty: "hard" }, "officer");
    testId = created.id;
    const unlocked = await request("/student/assigned/unlock", { code: created.code });
    assert.equal(unlocked.creator, "Dr. Kavya Rao");
    assert.equal(unlocked.config.difficulty, "hard");
    assert.equal(unlocked.config.revealAnswers, "after_close");
    const stored = (await db.query("SELECT questions FROM student.assessments WHERE id=$1", [testId])).rows[0].questions;
    assert.deepEqual(stored[2].expectedPoints, ["Outcome evidence"], "blank expected points are dropped");
    const other = await request("/placement/tools/assessments", { ...assigned(), title: "Cell test", revealAnswers: "immediately" }, "cell");
    const fallback = await request("/student/assigned/unlock", { code: other.code });
    assert.equal(fallback.creator, "placement.cell");
    const list = await request("/placement/tools/assessments", undefined, "officer");
    assert.equal(list.find((row) => row.id === testId).count, 3);
  });

  await t.test("integrity severity is server-derived and high-risk events are counted", async () => {
    const code = (await request(`/placement/tools/assessments/${testId}/code`, {}, "officer")).code;
    attemptId = (await request(`/student/assessments/${testId}/start`, { code, accepted: true })).id;
    await request(`/student/attempts/${attemptId}/integrity`, { kind: "face-missing" }, "a", 400);
    await request(`/student/attempts/${attemptId}/integrity`, { kind: "window-blur", severity: "high" }, "a", 400);
    for (const kind of ["window-blur", "tab-hidden", "clipboard", "fullscreen-exit"])
      await request(`/student/attempts/${attemptId}/integrity`, { kind });
    // A repeat of the same kind within two seconds is the same incident.
    assert.deepEqual(await request(`/student/attempts/${attemptId}/integrity`, { kind: "window-blur" }), { events: 4, highRisk: 2 });
    const live = await request(`/student/attempts/${attemptId}`);
    assert.deepEqual(live.integrity.map((e) => e.severity), ["low", "medium", "high", "high"]);
    assert.equal(live.answerRelease.withheld, true);
    // Only inactivity carries a client-reported duration.
    await db.query("UPDATE student.attempts SET integrity=(SELECT jsonb_agg(e||jsonb_build_object('at',(now()-interval '1 minute')::text)) FROM jsonb_array_elements(integrity) e) WHERE id=$1", [attemptId]);
    await request(`/student/attempts/${attemptId}/integrity`, { kind: "tab-hidden", seconds: 50 });
    await request(`/student/attempts/${attemptId}/integrity`, { kind: "inactive", seconds: 75 });
    const events = (await request(`/student/attempts/${attemptId}`)).integrity;
    assert.deepEqual(events.slice(-2).map((e) => [e.kind, e.seconds, e.severity]), [["tab-hidden", 0, "medium"], ["inactive", 75, "medium"]]);
  });

  await t.test("answers stay withheld until the window closes, then release", async () => {
    const result = await request(`/student/attempts/${attemptId}/submit`, { answers: { q1: "1", q2: "1", q3: "The project cut processing time by 40%." } });
    assert.equal(result.percentage, 50);
    assert.equal(result.answersWithheld, true);
    assert.ok(result.answersReleaseAt);
    assert.equal(result.highRisk, 2);
    assert.deepEqual(result.integritySummary, { total: 6, high: 2, medium: 3, low: 1 });
    // "Writing" has a single question, so section data would reveal its mark.
    const withheld = (payload, path) => {
      for (const key of SECTION_FIELDS) assert.equal(payload[key], undefined, `${path}: ${key}`);
      for (const q of payload.review || []) for (const key of KEYS) assert.equal(q[key], undefined, `${path}: ${key}`);
    };
    withheld(result, "submit");
    assert.deepEqual([result.score, result.maximum, result.correct, result.unanswered], [3, 6, 1, 0], "totals stay visible");
    assert.equal(result.review[2].answer, "The project cut processing time by 40%.");
    withheld(await request(`/student/attempts/${attemptId}/evaluate`, {}), "evaluate");
    const attempt = await request(`/student/attempts/${attemptId}`);
    withheld(attempt.result, "attempt");
    assert.equal(attempt.insights, null);
    assert.deepEqual(attempt.grading, { q3: { id: "q3" } });
    const history = (await request("/student/assessments/history")).find((row) => row.id === attemptId);
    assert.equal(history.result.review, undefined);
    withheld(history.result, "history");
    assert.equal(history.result.highRisk, 2);
    assert.equal(history.integritySummary.high, 2);
    assert.equal((await request(`/student/attempts/${attemptId}/insights`, {}, "a", 409)).code, "ANSWERS_WITHHELD");
    const officer = await request(`/placement/tools/assessments/${testId}/results`, undefined, "officer");
    assert.equal(officer[0].highRisk, 2);
    assert.equal(officer[0].result.review[0].expected, "Four", "officers always see the key");
    assert.equal(officer[0].result.sections.length, 2, "officers always see section marks");
    await db.query("UPDATE student.assessments SET opens_at=now()-interval '2 hours',closes_at=now()-interval '1 second' WHERE id=$1", [testId]);
    const released = await request(`/student/attempts/${attemptId}`);
    assert.equal(released.result.answersWithheld, false);
    assert.equal(released.result.review[0].expected, "Four");
    assert.equal(released.result.review[1].state, "incorrect");
    assert.equal(released.result.review[2].feedback, "Name a measured outcome.");
    assert.deepEqual(released.result.sections.map((s) => [s.name, s.score, s.maximum]), [["Reasoning", 2, 4], ["Writing", 1, 2]]);
    assert.deepEqual(released.result.weaknesses, ["Reasoning", "Writing"]);
    assert.equal(released.grading.q3.score, 1);
    const releasedHistory = (await request("/student/assessments/history")).find((row) => row.id === attemptId);
    assert.deepEqual(releasedHistory.result.strengths, ["Reasoning"]);
  });

  await t.test("immediate release shows answers on submission", async () => {
    const created = await request("/placement/tools/assessments", { ...assigned(), title: "Open review", revealAnswers: "immediately" }, "officer");
    const started = await request(`/student/assessments/${created.id}/start`, { code: created.code, accepted: true });
    const result = await request(`/student/attempts/${started.id}/submit`, { answers: { q1: "1" } });
    assert.equal(result.answersWithheld, false);
    assert.equal(result.review[0].expected, "Four");
    assert.equal(result.review[2].state, "unanswered");
  });

  await t.test("AI diagnosis must cite real questions that support each claim", async () => {
    const active = await request("/student/practice/aptitude/1", {});
    const activeAttempt = await request(`/student/assessments/${active.id}/start`, { accepted: true });
    assert.equal((await request(`/student/attempts/${activeAttempt.id}/insights`, {}, "a", 409)).code, "RESULT_FIRST");
    await request(`/student/attempts/${attemptId}/insights`, {}, "b", 404);
    const valid = {
      strengths: [{ text: "Accurate arithmetic recall", questionIds: ["q1"] }],
      weaknesses: [{ text: "Parity rules", questionIds: ["q2"] }, { text: "Evidence in written answers", questionIds: ["q3"] }],
      suggestions: [{ text: "Practise odd and even number rules", questionIds: ["q2", "q2"] }],
    };
    for (const bad of [
      { ...valid, suggestions: [{ text: "Unknown question", questionIds: ["q9"] }] },
      { ...valid, strengths: [{ text: "Parity mastery", questionIds: ["q2"] }] },
      { ...valid, weaknesses: [{ text: "Arithmetic", questionIds: ["q1"] }] },
    ]) {
      insightsOutput = () => bad;
      assert.equal((await request(`/student/attempts/${attemptId}/insights`, {}, "a", 502)).code, "AI_INVALID_RESPONSE");
      assert.equal((await request(`/student/attempts/${attemptId}`)).insights, null);
    }
    let seen;
    insightsOutput = (input) => ((seen = input), valid);
    const insights = await request(`/student/attempts/${attemptId}/insights`, {});
    assert.deepEqual(insights.suggestions[0].questionIds, ["q2"]);
    assert.deepEqual(seen.questions.map((q) => q.state), ["correct", "incorrect", "partial"]);
    assert.equal(seen.questions[1].expected, "Two");
    const before = calls.length;
    assert.deepEqual(await request(`/student/attempts/${attemptId}/insights`, {}), insights);
    assert.equal(calls.length, before, "stored insights are reused");
    assert.deepEqual((await request(`/student/attempts/${attemptId}`)).insights, insights);
  });

  await t.test("officers draft questions with AI; drafts are validated and never saved", async () => {
    const body = { subject: "Quantitative aptitude", portions: "Ratios", topic: "Ratio and proportion", difficulty: "medium", questionType: "mcq", count: 2, marks: 2, instructions: "Use rupee amounts." };
    const count = async () => (await db.query("SELECT count(*)::int n FROM student.assessments")).rows[0].n;
    const before = await count();
    draftOutput = () => ({ questions: [mcq("Split ₹600 in the ratio 1 : 2. What is the larger share?", ["₹400", "₹200", "₹300"], 0, "Anything"), mcq("Simplify 6 : 9.", ["2 : 3", "3 : 2"], 0)] });
    await request("/placement/tools/assessments/generate", body, "a", 403);
    await request("/placement/tools/assessments/generate", { ...body, count: 21 }, "officer", 400);
    const drafts = (await request("/placement/tools/assessments/generate", body, "officer")).questions;
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every((q) => q.section === "Ratio and proportion" && q.marks === 2 && q.id === undefined));
    draftOutput = () => ({ questions: [mcq("Simplify 6 : 9.", ["2 : 3", "2 : 3"], 0), mcq("Simplify 4 : 8.", ["1 : 2", "2 : 1"], 0)] });
    assert.equal((await request("/placement/tools/assessments/generate", body, "officer", 502)).code, "AI_INVALID_RESPONSE");
    draftOutput = () => ({ questions: [mcq("Simplify 6 : 9.", ["2 : 3", "3 : 2"], 0), { ...mcq("Explain ratios.", [], null), type: "short", expectedPoints: ["Compare quantities"] }] });
    await request("/placement/tools/assessments/generate", body, "officer", 502);
    assert.equal((await request("/placement/tools/assessments/generate", { ...body, questionType: "mixed" }, "officer")).questions[1].type, "short");
    assert.equal(await count(), before, "drafting never creates an assessment");
    // Officers share the per-user AI budget of generate().
    await db.query("INSERT INTO student.ai_requests(user_id,kind,status) SELECT $1,'officer.assessment.generate','completed' FROM generate_series(1,12)", [users.officer]);
    assert.equal((await request("/placement/tools/assessments/generate", body, "officer", 429)).code, "AI_RATE_LIMIT");
    await db.exec("DELETE FROM student.ai_requests");
  });

  await t.test("written practice: an AI outage is retryable and never holds the level", async () => {
    const take = async (level) => {
      const paper = await request(`/student/practice/business-communication/${level}`, {});
      const started = await request(`/student/assessments/${paper.id}/start`, { accepted: true });
      const key = (await db.query("SELECT questions FROM student.assessments WHERE id=$1", [paper.id])).rows[0].questions;
      const answers = Object.fromEntries(key.map((q) => [q.id, q.type === "mcq" ? String(q.correctIndex) : "Dear team, please share the Q3 sales report by Friday 4 PM so the review can close on time."]));
      return { paper, started, key, answers };
    };
    for (const level of [1, 2]) {
      const { started, answers } = await take(level);
      assert.equal((await request(`/student/attempts/${started.id}/submit`, { answers })).percentage, 100);
    }
    const { paper, started, key, answers } = await take(3);
    assert.equal(key.filter((q) => q.type === "short").length, 1);
    gradingDown = true;
    assert.equal((await request(`/student/attempts/${started.id}/submit`, { answers }, "a", 503)).code, "AI_UNAVAILABLE");
    const saved = await request(`/student/attempts/${started.id}`);
    assert.deepEqual([saved.status, saved.result], ["submitted", null]);
    assert.equal((await request(`/student/attempts/${started.id}/evaluate`, {}, "a", 503)).code, "AI_UNAVAILABLE");
    // The ungraded attempt does not hold the level: a fresh paper can be drawn.
    const next = await request("/student/practice/business-communication/3", {});
    assert.notEqual(next.id, paper.id);
    assert.equal(next.resumed, false);
    assert.equal((await request("/student/practice/business-communication/4", {}, "a", 409)).code, "LEVEL_LOCKED");
    // Later, the same submitted answers are graded on retry and unlock the next level.
    gradingDown = false;
    const graded = await request(`/student/attempts/${started.id}/evaluate`, {});
    assert.deepEqual([graded.score, graded.maximum, graded.percentage], [7.5, 9, 83]);
    assert.ok((await request("/student/practice/business-communication/4", {})).id);
  });

  await t.test("without an AI provider, practice papers carry no written items", async () => {
    // Same database, no AI provider; this app must not close the shared pool.
    const plain = await buildApp({
      pool: { ...pool, end: async () => {} },
      env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 10000, ASSESSMENT_CODE_SECRET: "c".repeat(32) },
      logger: false,
      verify: async (token) => ({ id: users[token] }),
    });
    try {
      const call = async (path, body, expected = 200) => {
        const response = await plain.inject({ url: "/api/v1" + path, method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer a" }, payload: body });
        assert.equal(response.statusCode, expected, path + ": " + response.body);
        return response.json().data;
      };
      const listing = await call("/student/practice");
      assert.deepEqual(listing.formats["business-communication"][2], { level: 3, questions: 6, written: 0, durationMinutes: 14 });
      // The unstarted paper drawn with AI (it has a written item) is not reused.
      const paper = await call("/student/practice/business-communication/3", {});
      const questions = (await db.query("SELECT questions FROM student.assessments WHERE id=$1", [paper.id])).rows[0].questions;
      assert.equal(questions.length, 6);
      assert.ok(questions.every((q) => q.type === "mcq"));
      const started = await call(`/student/assessments/${paper.id}/start`, { accepted: true });
      const result = await call(`/student/attempts/${started.id}/submit`, { answers: Object.fromEntries(questions.map((q) => [q.id, String(q.correctIndex)])) });
      assert.equal(result.percentage, 100, "the level completes without AI");
    } finally {
      await plain.close();
    }
  });
});
