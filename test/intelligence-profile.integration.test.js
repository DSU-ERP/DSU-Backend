import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { testDatabase } from "./helpers/database.js";

// Batch 2027. The target student (T01) has CGPA 8.52 and ties with T03.
const COHORT = [
  ["T01", "8.52", "CSE", "Asha Target"],
  ["T02", "9.10", "CSE", "Bala Top"],
  ["T03", "8.52", "ECE", "Chitra Tie"],
  ["T04", "8.60", "ECE", "Dev Next"],
  ["T05", "7.00", "CSE", "Esha Medium"],
  ["T06", "6.00", "CSE", "Farah Low"],
  ["T07", null, "CSE", "Gopal Unknown"],
];
const SECRETS = ["contact-unique@example.com", "9876501234", "Parent Uniquename", "SECRET-CIPHER-XYZ", "REFRESH-CIPHER-XYZ", "5550001111"];

async function setup() {
  const { db, pool } = await testDatabase();
  const ids = {};
  for (const [usn, cgpa, dept, name] of COHORT) {
    ids[usn] = randomUUID();
    await db.query(
      "INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name,department_name,course_name,current_semester) VALUES($1,$2,$3,'2027','h',$4,$4||' Engineering','B.Tech','7')",
      [ids[usn], usn, name, dept],
    );
    await db.query("INSERT INTO erp.academics(student_id,cgpa,sgpa,attendance,current_backlog) VALUES($1,$2,8.1,91.5,0)", [ids[usn], cgpa]);
  }
  const users = { student: randomUUID(), peer: randomUUID(), officer: randomUUID() };
  await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [Object.values(users)]);
  await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2),($3,'student',$4)", [users.student, ids.T01, users.peer, ids.T02]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [users.officer]);

  // Contact, family and profile details that must never reach officers or the AI.
  await db.query("INSERT INTO erp.contacts(student_id,details) VALUES($1,$2)", [ids.T01,
    JSON.stringify({ email: "contact-unique@example.com", phoneStudent1: "9876501234", fatherName: "Parent Uniquename" })]);
  await db.query("INSERT INTO student.profiles(user_id,details) VALUES($1,$2)", [users.student,
    JSON.stringify({ fullName: "Asha Target", phone: "5550001111", skills: "Python, SQL, React", interests: ["Machine learning"], cgpa: "9.99" })]);

  // Skills profile: onboarding complete, everything shared.
  await db.query(`INSERT INTO student.skill_profiles(student_id,onboarding_version,onboarding_completed_at,identity_confirmed_at,visibility_saved_at,consent_version,consented_at,revision)
    VALUES($1,student.onboarding_current_version(),now(),now(),now(),1,now(),4)`, [ids.T01]);
  const gh = randomUUID(), lc = randomUUID();
  await db.query(`INSERT INTO student.platform_accounts(id,student_id,platform,state,handle,profile_url,auth_method,ownership,external_id,sync_status,last_synced_at)
    VALUES($1,$2,'github','linked','asha-dev','https://github.com/asha-dev','github_app','platform_verified','101','completed',now())`, [gh, ids.T01]);
  await db.query(`INSERT INTO student.platform_accounts(id,student_id,platform,state,handle,profile_url,auth_method,ownership,submitted)
    VALUES($1,$2,'leetcode','linked','asha_lc','https://leetcode.com/u/asha_lc/','link_only','student_submitted','{"solved":240,"contestRating":1650}')`, [lc, ids.T01]);
  await db.query(`INSERT INTO student.platform_accounts(student_id,platform,state) VALUES($1,'hackerrank','declared_none'),($1,'kaggle','declared_none')`, [ids.T01]);
  await db.query(`INSERT INTO student.platform_accounts(student_id,platform,state,handle,profile_url,auth_method,ownership)
    VALUES($1,'linkedin','linked','asha','https://www.linkedin.com/in/asha','link_only','student_submitted')`, [ids.T01]);
  await db.query("INSERT INTO student.platform_credentials(account_id,kind,key_id,access_cipher,refresh_cipher) VALUES($1,'github_user_token','k1','SECRET-CIPHER-XYZ','REFRESH-CIPHER-XYZ')", [gh]);
  await db.query(`INSERT INTO student.platform_metrics(account_id,metric,student_id,platform,value,verification,method)
    VALUES($1,'repos.public',$2,'github','14','platform_verified','github_api'),($1,'activity.commits_90d',$2,'github','52','platform_verified','github_api')`, [gh, ids.T01]);
  const repo = (id, name, score, extra = "") => db.query(
    `INSERT INTO student.github_repositories(account_id,repo_id,student_id,full_name,name,url,description,primary_language,stars,recommendation_score,recommendation_reasons,additions_52w${extra ? ",pinned,pin_order" : ""})
     VALUES($1,$2,$3,'asha-dev/'||$4,$4,'https://github.com/asha-dev/'||$4,'Project '||$4,'Python',$5,$5,'["Has a README"]',1200${extra ? "," + extra : ""})`,
    [gh, id, ids.T01, name, score]);
  await repo(1, "alpha", 40, "true,1");
  await repo(2, "bravo", 90);
  await repo(3, "charlie", 70);
  await db.query("INSERT INTO student.featured_projects(student_id,position,account_id,repo_id) VALUES($1,1,$2,2)", [ids.T01, gh]);

  const calls = [];
  let reply = null;
  const studentAi = async ({ kind, task, input }) => {
    calls.push({ kind, task, input });
    if (reply) return reply(input);
    const id = (label) => input.evidence.find((e) => e.label.startsWith(label))?.id;
    return {
      summary: { text: "Official CGPA in the Advanced category — with verified GitHub projects.", evidence: [id("Official CGPA"), id("Featured project bravo")] },
      skills: [
        { name: "Python", evidence: [id("Featured project bravo")] },
        { name: "Kubernetes", evidence: [] },
        { name: "Rust", evidence: ["e999"] },
      ],
      projects: [{ name: "bravo", evidence: [id("Featured project bravo")] }],
      academicStrengths: [{ text: "Batch rank by official CGPA is listed.", evidence: [id("Batch rank")] }],
      achievements: [{ text: "Won a national hackathon.", evidence: [] }],
      developmentAreas: [{ text: "Readiness score 7/10.", evidence: [id("Official CGPA")] }],
      potentialRoles: [{ role: "Backend developer", rationale: "Python repositories.", evidence: [id("Featured project bravo")] }],
    };
  };
  const app = await buildApp({
    pool, logger: false, studentAi,
    env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 1000, STUDENT_AI_MODEL: "test/model" },
    verify: async (token) => ({ id: users[token] }),
  });
  const get = (path, who) => app.inject({ url: "/api/v1" + path, headers: { authorization: "Bearer " + who } });
  const post = (path, who, payload) => app.inject({ method: "POST", url: "/api/v1" + path, headers: { authorization: "Bearer " + who }, payload });
  const ok = async (promise, status = 200) => {
    const response = await promise;
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  return { db, ids, users, gh, app, get, post, ok, calls, setReply: (fn) => { reply = fn; } };
}

test("student intelligence profile service and routes", { timeout: 240000 }, async (t) => {
  const ctx = await setup();
  const { db, ids, app, get, post, ok, calls } = ctx;
  t.after(() => app.close());
  const examples = {};

  await t.test("canonical consistency: student, directory, officer and ai views agree", async () => {
    const mine = (await ok(get("/student/skills/profile", "student"))).data;
    examples.studentProfile = mine;
    assert.equal(mine.academic.cgpa, "8.52");
    assert.equal(mine.academic.category, "advanced");
    assert.equal(mine.academic.categoryLabel, "Advanced");
    assert.equal(mine.academic.eligible, true);
    assert.equal(mine.academic.provenance, "institution_verified");
    assert.deepEqual(mine.ranking, { batchRank: 3, categoryRank: 3, batchSize: 6, categorySize: 4, scope: "batch" });

    const ranks = (await db.query("SELECT * FROM erp.cgpa_ranks('2027') WHERE student_id=$1", [ids.T01])).rows[0];
    assert.deepEqual([ranks.batch_rank, ranks.category_rank, ranks.batch_size, ranks.category_size], [3, 3, 6, 4]);

    const directory = (await ok(get("/placement/categories/advanced/students?batch=2027", "officer"))).data;
    examples.directory = directory;
    const row = directory.rows.find((r) => r.id === ids.T01);
    assert.deepEqual([row.cgpa, row.category, row.batchRank, row.categoryRank], ["8.52", "advanced", 3, 3]);
    assert.deepEqual(directory.rows.map((r) => [r.usn, r.categoryRank]), [["T02", 1], ["T04", 2], ["T01", 3], ["T03", 3]]);

    const officer = (await ok(get(`/placement/students/${ids.T01}/profile`, "officer"))).data;
    examples.officerProfile = officer;
    const ai = (await ok(get(`/placement/students/${ids.T01}/profile?purpose=ai`, "officer"))).data;
    for (const view of [officer, ai]) {
      assert.deepEqual([view.core.cgpa, view.core.category, view.core.categoryLabel, view.core.eligible], ["8.52", "advanced", "Advanced", true]);
      assert.deepEqual(view.core.ranking, mine.ranking);
      assert.deepEqual(view.ranking, mine.ranking);
      for (const key of ["usn", "name", "department", "departmentName", "program", "batch", "semester", "cgpa", "category", "categoryLabel", "eligible", "provenance"])
        assert.deepEqual(view.core[key], mine.academic[key], key);
    }
    assert.equal(ai.purpose, "ai");
    assert.equal(ai.skills.featured[0].repo.url, undefined);

    // Same keys for shared concepts.
    const accountKeys = (a) => Object.keys(a).sort();
    const officerGithub = officer.skills.accounts.find((a) => a.platform === "github");
    const myGithub = mine.accounts.find((a) => a.platform === "github");
    assert.deepEqual(accountKeys(officerGithub), accountKeys(myGithub));
    assert.deepEqual(officerGithub.metrics, myGithub.metrics);
    assert.deepEqual(officer.skills.featured.map((f) => [f.position, f.source, f.repo.name]), mine.github.featured.map((f) => [f.position, f.source, f.repo.name]));
    assert.deepEqual(mine.github.featured.map((f) => [f.source, f.repo.name]), [["github_pinned", "alpha"], ["student_selected", "bravo"]]);
    for (const [index, f] of officer.skills.featured.entries())
      for (const key of Object.keys(f.repo)) assert.deepEqual(f.repo[key], mine.github.featured[index].repo[key], key);

    // Card counts reconcile with directory totals.
    const cards = (await ok(get("/placement/categories?batch=2027", "officer"))).data;
    examples.categories = cards;
    let sum = 0;
    for (const card of cards.cards) {
      const listed = (await ok(get(`/placement/categories/${card.id}/students?batch=2027`, "officer"))).data;
      assert.equal(listed.pagination.total, card.total, card.id);
      sum += card.total;
    }
    assert.equal(sum + cards.unclassified, cards.total);
    assert.deepEqual(cards.cards.map((c) => c.total), [4, 1, 1]);
  });

  await t.test("student self view details", async () => {
    const mine = (await ok(get("/student/skills/profile", "student"))).data;
    assert.equal(mine.revision, 4);
    assert.equal(mine.onboarding.complete, true);
    assert.deepEqual(mine.onboarding.missing, []);
    assert.deepEqual(mine.visibility, { platforms: true, projects: true, activity: true, summary: true });
    assert.deepEqual(mine.accounts.map((a) => [a.platform, a.state]), [["github", "linked"], ["leetcode", "linked"], ["hackerrank", "declared_none"], ["linkedin", "linked"], ["kaggle", "declared_none"]]);
    const lc = mine.accounts.find((a) => a.platform === "leetcode");
    assert.deepEqual(lc.submitted, { solved: 240, contestRating: 1650 });
    assert.equal(lc.ownership, "student_submitted");
    const github = mine.accounts.find((a) => a.platform === "github");
    assert.deepEqual(github.metrics.map((m) => [m.metric, m.label]), [["repos.public", "Public repositories"]]);
    assert.deepEqual(mine.github.activity.map((m) => m.metric), ["activity.commits_90d"]);
    assert.deepEqual(mine.github.repositories.map((r) => r.name), ["bravo", "charlie", "alpha"]);
    assert.deepEqual(mine.github.repositories[0].recommendationReasons, ["Has a README"]);
    assert.equal(mine.github.repositories[0].additions52w, 1200);
    assert.deepEqual(mine.github.pinned.map((r) => r.name), ["alpha"]);
    assert.equal(mine.summary, null);
    // Never from student.profiles.details (which claims 9.99).
    assert.ok(!JSON.stringify(mine).includes("9.99"));
    for (const secret of SECRETS) assert.ok(!JSON.stringify(mine).includes(secret), secret);
  });

  await t.test("readiness is descriptive with no numeric score", async () => {
    const mine = (await ok(get("/student/skills/profile", "student"))).data;
    const officer = (await ok(get(`/placement/students/${ids.T01}/profile`, "officer"))).data;
    for (const readiness of [mine.readiness, officer.readiness]) {
      assert.equal(readiness.status, "descriptive");
      assert.deepEqual(readiness.items.map((i) => i.key), ["academic_eligibility", "profile_completeness", "verified_projects", "coding_platforms", "missing_information"]);
      for (const item of readiness.items) {
        assert.deepEqual(Object.keys(item).sort(), ["detail", "key", "label", "provenance", "state"]);
        assert.ok(["met", "missing", "unavailable"].includes(item.state));
        for (const value of Object.values(item)) assert.equal(typeof value, "string");
        assert.ok(!/score/i.test(item.detail));
      }
      assert.ok(!JSON.stringify(readiness).includes("—"));
      const by = Object.fromEntries(readiness.items.map((i) => [i.key, i]));
      assert.equal(by.academic_eligibility.state, "met");
      assert.match(by.academic_eligibility.detail, /official CGPA only/);
      assert.equal(by.verified_projects.state, "met");
      assert.match(by.coding_platforms.detail, /LeetCode \(student submitted\)/);
      assert.match(by.coding_platforms.detail, /Not provided: HackerRank/);
      assert.match(by.coding_platforms.detail, /not evidence of skill level/);
    }
  });

  await t.test("students cannot call officer routes and officer views omit contacts", async () => {
    for (const path of ["/placement/categories", "/placement/categories/advanced/students", "/placement/overview/charts",
      "/placement/students/lookup?usn=T01", `/placement/students/${ids.T01}/profile`, "/placement/skills/students"]) {
      const response = await get(path, "student");
      assert.equal(response.statusCode, 403, path + " " + response.body);
    }
    for (const purpose of ["officer", "ai"]) {
      const text = (await get(`/placement/students/${ids.T01}/profile?purpose=${purpose}`, "officer")).body;
      for (const secret of SECRETS) assert.ok(!text.includes(secret), purpose + " leaked " + secret);
    }
    assert.equal((await get("/placement/categories/elite/students", "officer")).statusCode, 400);
    assert.equal((await get("/placement/categories/advanced/students?sort=drop", "officer")).statusCode, 400);
    assert.equal((await get("/placement/categories/advanced/students?extra=1", "officer")).statusCode, 400);
    assert.equal((await get("/placement/students/not-a-uuid/profile", "officer")).statusCode, 400);
    assert.equal((await get(`/placement/students/${ids.T01}/profile?purpose=marketing`, "officer")).statusCode, 400);
    assert.equal((await get(`/placement/students/${randomUUID()}/profile`, "officer")).statusCode, 404);
    assert.equal((await get("/student/skills/profile", "officer")).statusCode, 403);
  });

  await t.test("officer lookups, skill students and overview charts", async () => {
    const lookup = (await ok(get("/placement/students/lookup?usn=t01", "officer"))).data;
    examples.lookup = lookup;
    assert.equal(lookup.exact, true);
    assert.equal(lookup.matches[0].id, ids.T01);
    assert.equal((await get("/placement/students/lookup", "officer")).statusCode, 400);
    const skills = (await ok(get("/placement/skills/students?batch=2027&status=complete", "officer"))).data;
    examples.skillStudents = skills;
    assert.deepEqual(skills.rows.map((r) => [r.usn, r.linkedPlatforms]), [["T01", ["github", "leetcode", "linkedin"]]]);
    const charts = (await ok(get("/placement/overview/charts?batch=2027", "officer"))).data;
    examples.charts = charts;
    assert.equal(charts.kpis.totalStudents, 7);
    assert.equal(charts.status.reduce((s, x) => s + x.count, 0), 7);
  });

  await t.test("existing /placement/:resource reads still reach dsu_placement_read", async () => {
    const session = (await ok(get("/placement/session", "officer"))).data;
    assert.equal(session.role, "placement_officer");
    const overview = await ok(get("/placement/overview?batch=2027", "officer"));
    assert.ok(overview.data.options, "overview comes from placement.report");
    assert.equal(overview.data.kpis?.totalStudents, undefined);
    assert.equal((await get("/placement/session", "student")).statusCode, 403);
    const cards = (await ok(get("/placement/categories", "officer"))).data;
    assert.ok(Array.isArray(cards.cards));
  });

  await t.test("summary generation is grounded, private and cached", async () => {
    const generated = (await ok(post("/student/skills/summary", "student", { action: "generate" }))).data;
    examples.summary = generated;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "profile.summary");
    const input = JSON.stringify(calls[0].input);
    for (const secret of [...SECRETS, "github.com/asha-dev", "9.99"]) assert.ok(!input.includes(secret), "AI input leaked " + secret);
    assert.ok(input.includes("Python, SQL, React"));
    const evidence = calls[0].input.evidence;
    assert.ok(evidence.every((e) => /^e\d+$/.test(e.id) && e.provenance));
    assert.equal(evidence.find((e) => e.label === "Official CGPA").provenance, "institution_verified");
    assert.equal(evidence.find((e) => e.label.startsWith("LeetCode (student submitted)")).provenance, "student_submitted");

    assert.equal(generated.provenance, "ai_generated");
    assert.equal(generated.cached, false);
    assert.equal(generated.model, "test/model");
    assert.equal(generated.hidden, false);
    const content = generated.content;
    assert.ok(!content.summary.text.includes("—"));
    assert.deepEqual(content.skills.map((s) => s.name), ["Python"]); // uncited and unknown ids dropped
    assert.deepEqual(content.achievements, []);
    assert.deepEqual(content.developmentAreas, []); // score-like text dropped
    assert.deepEqual(content.potentialRoles.map((r) => r.role), ["Backend developer"]);
    assert.equal(generated.evidence.length, evidence.length);
    const stored = (await db.query("SELECT input_hash,sources FROM student.profile_summaries WHERE id=$1", [generated.id])).rows[0];
    assert.match(stored.input_hash, /^[0-9a-f]{64}$/);
    // The evidence groups it used are recorded so officers stop seeing it once any is hidden.
    assert.deepEqual(stored.sources, ["activity", "platforms:github", "platforms:leetcode", "platforms:linkedin", "projects"]);
    assert.ok(generated.evidence.filter((e) => ["platform", "metric", "submitted"].includes(e.kind)).every((e) => e.platform));

    const again = (await ok(post("/student/skills/summary", "student", { action: "generate" }))).data;
    assert.equal(again.id, generated.id);
    assert.equal(again.cached, true);
    assert.equal(calls.length, 1);

    const officer = (await ok(get(`/placement/students/${ids.T01}/profile`, "officer"))).data;
    assert.equal(officer.summary.id, generated.id);
    assert.equal(officer.summary.provenance, "ai_generated");
    assert.equal(officer.summaryWithheld, false);

    // Hiding an account the summary relied on withholds it from officers (and the AI
    // view) without any extra code path; the student still sees their own summary.
    await db.query("UPDATE student.platform_accounts SET visible=false WHERE student_id=$1 AND platform='leetcode'", [ids.T01]);
    for (const purpose of ["officer", "ai"]) {
      const view = (await ok(get(`/placement/students/${ids.T01}/profile?purpose=${purpose}`, "officer"))).data;
      assert.deepEqual([view.summary, view.summaryWithheld], [null, true], purpose);
      assert.ok(!JSON.stringify(view).includes("asha_lc"), purpose);
    }
    assert.equal((await ok(get("/student/skills/profile", "student"))).data.summary.id, generated.id);
    await db.query("UPDATE student.platform_accounts SET visible=true WHERE student_id=$1 AND platform='leetcode'", [ids.T01]);
    await db.query("UPDATE student.skill_profiles SET visibility=visibility||'{\"activity\":false}' WHERE student_id=$1", [ids.T01]);
    assert.equal((await ok(get(`/placement/students/${ids.T01}/profile`, "officer"))).data.summaryWithheld, true);
    await db.query("UPDATE student.skill_profiles SET visibility=visibility||'{\"activity\":true}' WHERE student_id=$1", [ids.T01]);
    assert.equal((await ok(get(`/placement/students/${ids.T01}/profile`, "officer"))).data.summary.id, generated.id);

    const reviewed = (await ok(post("/student/skills/summary", "student", { action: "review", id: generated.id }))).data;
    assert.ok(reviewed.reviewedAt);
    const hidden = (await ok(post("/student/skills/summary", "student", { action: "hide", id: generated.id, hidden: true }))).data;
    assert.equal(hidden.hidden, true);
    assert.equal((await ok(get(`/placement/students/${ids.T01}/profile`, "officer"))).data.summary, null);
    const mine = (await ok(get("/student/skills/profile", "student"))).data;
    assert.equal(mine.summary.id, generated.id);
    assert.equal(mine.summary.hidden, true);
    // Another student cannot touch it.
    assert.equal((await post("/student/skills/summary", "peer", { action: "hide", id: generated.id, hidden: false })).statusCode, 404);
    assert.equal((await post("/student/skills/summary", "student", { action: "erase", id: generated.id })).statusCode, 400);
    await ok(post("/student/skills/summary", "student", { action: "hide", id: generated.id, hidden: false }));
  });

  await t.test("summary rejects ungrounded or invalid output and limits attempts, not successes", async () => {
    const { setReply } = ctx;
    const attempts = async () => (await db.query("SELECT count(*)::int AS n FROM student.profile_summary_attempts WHERE student_id=$1", [ids.T01])).rows[0].n;
    assert.equal(await attempts(), 1, "the cached reuse above was not an attempt");
    const setSkills = (skills) => db.query("UPDATE student.profiles SET details=details||jsonb_build_object('skills',$2::text) WHERE user_id=$1", [ctx.users.student, skills]);
    await setSkills("Go");
    let seen;
    setReply(async () => {
      seen = await attempts(); // recorded before the model is called
      return { summary: { text: "x", evidence: [] }, skills: [], projects: [], academicStrengths: [], achievements: [], developmentAreas: [], potentialRoles: [] };
    });
    const empty = await post("/student/skills/summary", "student", { action: "generate" });
    assert.equal(empty.statusCode, 502);
    assert.equal(empty.json().error.code, "AI_INVALID_RESPONSE");
    assert.equal(seen, 2);
    setReply(() => ({ summary: { text: "x", evidence: ["e1"] }, extra: true }));
    const invalid = await post("/student/skills/summary", "student", { action: "generate" });
    assert.equal(invalid.statusCode, 502);
    assert.equal(invalid.json().error.code, "AI_INVALID_RESPONSE");
    // Two failed attempts plus one success: the hourly budget of 3 is used up even
    // though only one summary was stored.
    assert.equal((await db.query("SELECT count(*)::int AS n FROM student.profile_summaries WHERE student_id=$1", [ids.T01])).rows[0].n, 1);
    setReply(() => ({ summary: { text: "Official academic record is listed.", evidence: ["e1"] }, skills: [], projects: [], academicStrengths: [], achievements: [], developmentAreas: [], potentialRoles: [] }));
    await setSkills("Go, Rust");
    const before = calls.length;
    const limited = await post("/student/skills/summary", "student", { action: "generate" });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "SUMMARY_LIMIT");
    assert.equal(calls.length, before, "no model call once the limit is reached");
    assert.equal(await attempts(), 3, "a refused request is not recorded");
    // Older attempts leave the window.
    await db.query("UPDATE student.profile_summary_attempts SET created_at=created_at-interval '61 minutes' WHERE student_id=$1", [ids.T01]);
    await ok(post("/student/skills/summary", "student", { action: "generate" }));
    assert.equal(calls.length, before + 1);
  });

  await t.test("visibility hides platforms, projects and summary from officers only", async () => {
    await db.query("UPDATE student.skill_profiles SET visibility='{\"platforms\":false,\"projects\":false,\"activity\":false,\"summary\":false}' WHERE student_id=$1", [ids.T01]);
    const officer = (await ok(get(`/placement/students/${ids.T01}/profile`, "officer"))).data;
    assert.ok(officer.skills.accounts.every((a) => a.handle === null && a.metrics.length === 0));
    assert.deepEqual([officer.skills.featured, officer.skills.repositories, officer.skills.activity, officer.summary], [[], [], [], null]);
    assert.ok(!JSON.stringify(officer).includes("asha-dev"));
    const by = Object.fromEntries(officer.readiness.items.map((i) => [i.key, i]));
    assert.equal(by.verified_projects.state, "unavailable");
    assert.equal(by.coding_platforms.state, "unavailable");
    // Core academics stay visible: they are institution records, not student choices.
    assert.equal(officer.core.cgpa, "8.52");
    const mine = (await ok(get("/student/skills/profile", "student"))).data;
    assert.equal(mine.visibility.platforms, false);
    assert.equal(mine.accounts.find((a) => a.platform === "github").handle, "asha-dev");
    assert.equal(mine.github.featured.length, 2);
    assert.ok(mine.summary);
  });

  await t.test("export returns all rows and surfaces the 429 export limit", async () => {
    for (let i = 0; i < 5; i++) {
      const exported = (await ok(get("/placement/categories/advanced/students?batch=2027&export=true&limit=1", "officer"))).data;
      assert.equal(exported.rows.length, 4);
    }
    const limited = await get("/placement/categories/advanced/students?batch=2027&export=true", "officer");
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "PT429");
  });

  if (process.env.PRINT_EXAMPLES) console.log(JSON.stringify(examples, null, 2));
});
