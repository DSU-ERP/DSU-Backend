import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { enqueueScheduled, workerTransaction } from "../src/modules/intelligence/sync.js";
import { drainQueue, requestFullRecalculation } from "../src/modules/ranking/service.js";
import { TOPICS } from "../src/modules/ranking/taxonomy.js";
import { testDatabase } from "./helpers/database.js";

const MODEL = JSON.parse(readFileSync(new URL("../src/modules/ranking/model-v1.json", import.meta.url), "utf8"));

// Synthetic cohort (in-memory database only). [usn, batch, department, cgpa]
const COHORT = [
  ["R01", "2027", "CSE", "9.10"],
  ["R02", "2027", "CSE", "8.52"],
  ["R03", "2027", "CSE", "8.52"],
  ["R04", "2027", "CSE", null],
  ["R05", "2027", "ECE", "8.80"],
  ["R06", "2027", "ECE", "7.00"],
  ["R07", "2028", "MECH", "9.50"],
];

async function setup() {
  const { db, pool } = await testDatabase();
  const ids = {};
  for (const [usn, batch, dept, cgpa] of COHORT) {
    ids[usn] = randomUUID();
    await db.query(
      `INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name,department_name,current_semester)
       VALUES($1,$2,'Student '||$2,$3,'h',$4,$4||' Engineering','7')`,
      [ids[usn], usn, batch, dept],
    );
    await db.query("INSERT INTO erp.academics(student_id,cgpa) VALUES($1,$2)", [ids[usn], cgpa]);
  }
  const users = { officer: randomUUID(), student: randomUUID(), outsider: randomUUID() };
  await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [Object.values(users)]);
  await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [users.student, ids.R01]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [users.officer]);

  const consent = (id) =>
    db.query(`INSERT INTO student.skill_profiles(student_id,onboarding_version,onboarding_completed_at,identity_confirmed_at,visibility_saved_at,consent_version,consented_at)
      VALUES($1,student.onboarding_current_version(),now(),now(),now(),1,now())`, [id]);
  const leetcode = async (id, handle, counts, { tags = [], visible = true, syncedDaysAgo = 1 } = {}) => {
    const account = randomUUID();
    await db.query(`INSERT INTO student.platform_accounts(id,student_id,platform,state,handle,profile_url,auth_method,ownership,visible,sync_status,last_synced_at)
      VALUES($1,$2,'leetcode','linked',$3,'https://leetcode.com/u/'||$3||'/','public_api','student_submitted',$4,'completed',now()-make_interval(days=>$5))`,
      [account, id, handle, visible, syncedDaysAgo]);
    const metrics = { "problems.easy": counts[0], "problems.medium": counts[1], "problems.hard": counts[2], "problems.solved": counts[0] + counts[1] + counts[2], "topics.solved": tags };
    for (const [metric, value] of Object.entries(metrics))
      await db.query(`INSERT INTO student.platform_metrics(account_id,metric,student_id,platform,value,verification,method)
        VALUES($1,$2,$3,'leetcode',$4,'platform_verified','leetcode_public_graphql')`, [account, metric, id, JSON.stringify(value)]);
    return account;
  };
  const github = async (id, handle, repos, { visible = true } = {}) => {
    const account = randomUUID();
    await db.query(`INSERT INTO student.platform_accounts(id,student_id,platform,state,handle,profile_url,auth_method,ownership,external_id,visible,sync_status,last_synced_at)
      VALUES($1,$2,'github','linked',$3,'https://github.com/'||$3,'github_app','platform_verified',$4,$5,'completed',now())`,
      [account, id, handle, String(Math.floor(Math.random() * 1e9)), visible]);
    for (const [i, quality] of repos.entries()) {
      const strong = quality === "strong";
      await db.query(`INSERT INTO student.github_repositories(account_id,repo_id,student_id,full_name,name,url,description,primary_language,languages,topics,
          has_readme,readme_bytes,license,pushed_at,owner_login,additions_52w,evidence)
        VALUES($1,$2::bigint,$3,$4||'/r'||$2::text,'r'||$2::text,'https://github.com/'||$4||'/r'||$2::text,$5,'TypeScript',$6,$7,$8,$9,$10,now()-interval '5 days',$4,$11,$12)`,
        [account, 1000 + i, id, handle, strong ? "Placement API" : null,
          JSON.stringify(strong ? { TypeScript: 300000, CSS: 10000 } : { HTML: 900 }), JSON.stringify(strong ? ["nextjs", "api"] : []),
          strong, strong ? 3000 : null, strong ? "MIT" : null, strong ? 4000 : null,
          JSON.stringify(strong
            ? { observed: true, rootEntries: 12, manifests: ["package.json"], tests: true, sourceDirs: true, gitignore: true, ci: true, docker: false, workflows: 1, releases: 0, diskKb: 400, stats: { commits: 40, totalCommits: 50, contributors: 2 } }
            : { observed: true, rootEntries: 1, manifests: [], tests: false, sourceDirs: false, gitignore: false, ci: false, docker: false, workflows: 0, releases: 0, diskKb: 1, stats: null })]);
    }
  };

  for (const usn of ["R01", "R02", "R05", "R07"]) await consent(ids[usn]);
  // R01: complete evidence. R07: complete (another programme, same rules).
  await leetcode(ids.R01, "r01-lc", [80, 120, 25], { tags: [{ slug: "array", solved: 60 }, { slug: "dynamic-programming", solved: 20 }] });
  await github(ids.R01, "r01-gh", ["strong", "strong", "weak"]);
  await leetcode(ids.R07, "r07-lc", [40, 30, 2], { tags: [{ slug: "array", solved: 30 }] });
  await github(ids.R07, "r07-gh", ["strong"]);
  // R02 and R05 claim the same LeetCode username: both disputed. R02 hides GitHub.
  await leetcode(ids.R02, "shared-handle", [10, 10, 1]);
  await github(ids.R02, "r02-gh", ["strong"], { visible: false });
  await leetcode(ids.R05, "Shared-Handle", [10, 10, 1]);
  // R03 linked LeetCode but never consented: nothing from it may be used.
  await leetcode(ids.R03, "r03-lc", [500, 500, 100]);

  const app = await buildApp({
    pool, logger: false,
    env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 1000 },
    verify: async (token) => ({ id: users[token] }),
  });
  const get = (path, who = "officer") => app.inject({ url: "/api/v1" + path, headers: { authorization: "Bearer " + who } });
  const ok = async (path, who) => {
    const response = await get(path, who);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  const recalc = async () => {
    let n = 0;
    while (await drainQueue(pool)) n++;
    return n;
  };
  return { db, pool, ids, app, get, ok, recalc };
}

test("students ranking: engine, worker, officer API and access control", { timeout: 240000 }, async (t) => {
  const { db, pool, ids, app, get, ok, recalc } = await setup();
  t.after(() => app.close());

  await t.test("the seeded model and taxonomy match the code", async () => {
    const model = (await db.query("SELECT config,status,current FROM ranking.models")).rows;
    assert.equal(model.length, 1);
    assert.deepEqual(model[0].config, MODEL);
    assert.deepEqual([model[0].status, model[0].current], ["experimental", true]);
    const topics = (await db.query("SELECT code,family,label,source FROM ranking.topics ORDER BY position")).rows;
    assert.deepEqual(topics, TOPICS.map(({ code, family, label, source }) => ({ code, family, label, source })));
  });

  await t.test("worker-only functions refuse ordinary API transactions", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await assert.rejects(client.query("SELECT ranking.calculation_inputs(ARRAY[]::uuid[])"), /restricted to the sync worker/);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await assert.rejects(client.query("SELECT ranking.request_recalculation($1,'manual')", [ids.R01]), /restricted to the sync worker/);
    await client.query("ROLLBACK");
  });

  await t.test("a full pass scores every student once; a second pass inside the window queues nothing", async () => {
    assert.equal(await requestFullRecalculation(pool, 24), COHORT.length);
    assert.ok(await recalc());
    assert.equal(await requestFullRecalculation(pool, 24), 0);
    const rows = (await db.query("SELECT s.enrollment_no AS usn,x.* FROM ranking.scores x JOIN erp.students s ON s.id=x.student_id ORDER BY 1")).rows;
    assert.equal(rows.length, COHORT.length);
    const by = Object.fromEntries(rows.map((r) => [r.usn, r]));
    assert.deepEqual([by.R01.developer_status, by.R01.evidence_state], ["scored", "complete"]);
    assert.deepEqual([by.R07.developer_status, by.R07.evidence_state], ["scored", "complete"]);
    assert.deepEqual([by.R02.dsa_status, by.R05.dsa_status], ["disputed", "disputed"], "case-insensitive duplicate claim");
    assert.equal(by.R02.github_status, "hidden");
    assert.deepEqual([by.R03.dsa_status, by.R03.dsa], ["hidden", null], "no consent, no use");
    assert.deepEqual([by.R04.academic_status, by.R04.academic], ["missing", null]);
    assert.equal(by.R06.dsa_status, "not_linked");
    assert.equal(Number(by.R01.academic), 91);
    const developer = by.R01.explanation.developer;
    assert.ok(Math.abs(developer.score - (0.5 * 91 + 0.3 * by.R01.explanation.dsa.score + 0.2 * by.R01.explanation.github.score)) < 0.01);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM ranking.score_history")).rows[0].n, COHORT.length);
  });

  await t.test("academic ranking: university-wide dense ranks, ties by USN, missing CGPA unranked", async () => {
    const all = await ok("/placement/rankings?kind=academic");
    assert.deepEqual(all.rows.map((r) => [r.usn, r.rank]), [["R07", 1], ["R01", 2], ["R05", 3], ["R02", 4], ["R03", 4], ["R06", 5]]);
    assert.deepEqual([all.pagination.total, all.scope.ranked], [6, 6]);
    const withPending = await ok("/placement/rankings?kind=academic&show=all");
    assert.deepEqual(withPending.rows.at(-1).usn, "R04");
    assert.equal(withPending.rows.at(-1).rank, null);
    assert.equal(withPending.rows.at(-1).statuses.academic, "missing");
  });

  await t.test("cohort filters define the ranked group; search and page only hide rows", async () => {
    const cse = await ok("/placement/rankings?kind=academic&batch=2027&department=CSE");
    assert.deepEqual(cse.rows.map((r) => [r.usn, r.rank]), [["R01", 1], ["R02", 2], ["R03", 2]]);
    const search = await ok("/placement/rankings?kind=academic&search=r03");
    assert.deepEqual(search.rows.map((r) => [r.usn, r.rank]), [["R03", 4]], "search keeps the university rank");
    const page2 = await ok("/placement/rankings?kind=academic&limit=2&page=2");
    assert.deepEqual(page2.rows.map((r) => r.usn), ["R05", "R02"]);
    assert.deepEqual(page2.pagination, { total: 6, page: 2, limit: 2 });
    const semester = await ok("/placement/rankings?kind=academic&semester=3");
    assert.equal(semester.rows.length, 0);
  });

  await t.test("DSA, GitHub, developer and topic rankings only rank evidenced students", async () => {
    const dsa = await ok("/placement/rankings?kind=dsa");
    assert.deepEqual(dsa.rows.map((r) => [r.usn, r.rank]), [["R01", 1], ["R07", 2]]);
    const gh = await ok("/placement/rankings?kind=github");
    assert.deepEqual(gh.rows.map((r) => r.usn).sort(), ["R01", "R07"]);
    const dev = await ok("/placement/rankings?kind=developer");
    assert.deepEqual(dev.rows.map((r) => r.usn).sort(), ["R01", "R07"], "every programme with complete evidence is eligible");
    assert.ok(dev.rows.every((r) => r.evidenceState === "complete"));
    const pending = await ok("/placement/rankings?kind=developer&show=all&evidence=pending");
    assert.ok(pending.rows.every((r) => r.rank === null && r.evidenceState === "pending"));
    const arrays = await ok("/placement/rankings?kind=topic&topic=dsa.arrays");
    assert.deepEqual(arrays.rows.map((r) => [r.usn, r.rank]), [["R01", 1], ["R07", 2]]);
    assert.equal(arrays.rows[0].topic.evidence.solved, 60);
    const web = await ok("/placement/rankings?kind=topic&topic=project.web");
    assert.ok(web.rows.length >= 1);
  });

  await t.test("overview counts are real counts from the cohort", async () => {
    const overview = await ok("/placement/rankings/overview");
    assert.deepEqual(overview.counts.students, 7);
    assert.deepEqual(overview.counts.validCgpa, 6);
    assert.deepEqual(overview.counts.githubLinked, 3);
    assert.deepEqual(overview.counts.leetcodeLinked, 5);
    assert.deepEqual(overview.counts.developerEligible, 2);
    assert.equal(overview.counts.notCalculated, 0);
    assert.equal(overview.model.version, MODEL.version);
    assert.deepEqual(overview.model.weights, MODEL.weights);
    assert.deepEqual(overview.options.batches, ["2028", "2027"]);
    assert.deepEqual(overview.options.departments.map((d) => d.code), ["CSE", "ECE", "MECH"]);
    assert.equal(overview.topics.find((x) => x.code === "dsa.arrays").students, 2);
    assert.equal(overview.topics.find((x) => x.code === "core.dbms").source, null);
    const mech = await ok("/placement/rankings/overview?department=MECH");
    assert.equal(mech.counts.students, 1);
  });

  await t.test("student detail explains every component and position", async () => {
    const detail = await ok(`/placement/rankings/students/${ids.R01}`);
    assert.equal(detail.student.usn, "R01");
    assert.equal(detail.score.statuses.developer, "scored");
    assert.deepEqual(detail.positions.academic.university, { rank: 2, of: 6 });
    assert.deepEqual(detail.positions.academic.department, { rank: 1, of: 3 });
    assert.deepEqual(detail.positions.dsa.university, { rank: 1, of: 2 });
    assert.ok(detail.score.explanation.github.explanation.top.length >= 2);
    const dbms = detail.topics.find((x) => x.code === "core.dbms");
    assert.deepEqual([dbms.source, dbms.score], [null, null], "core subjects are not assessed in v1");
    const pending = await ok(`/placement/rankings/students/${ids.R06}`);
    assert.equal(pending.score.statuses.developer, "pending");
    assert.ok(pending.score.explanation.developer.explanation.blockers.length);
    assert.equal((await get(`/placement/rankings/students/${randomUUID()}`)).statusCode, 404);
  });

  await t.test("new evidence recalculates one student; unchanged evidence adds no history", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM ranking.score_history")).rows[0].n;
    await db.query("UPDATE student.platform_metrics SET value='200' WHERE student_id=$1 AND metric='problems.hard'", [ids.R07]);
    await workerTransaction(pool, (c) => c.query("SELECT ranking.request_recalculation($1,'sync')", [ids.R07]));
    await workerTransaction(pool, (c) => c.query("SELECT ranking.request_recalculation($1,'sync')", [ids.R06]));
    assert.ok(await recalc());
    assert.equal((await db.query("SELECT count(*)::int AS n FROM ranking.score_history")).rows[0].n, before + 1, "only R07 changed");
    const dsa = await ok("/placement/rankings?kind=dsa");
    assert.equal(dsa.rows[0].usn, "R07");
    const runs = (await db.query("SELECT kind,students,changed FROM ranking.runs WHERE kind='batch' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(runs, { kind: "batch", students: 2, changed: 1 });
  });

  await t.test("a student hiding a platform removes it from the officer view on the next batch", async () => {
    const hide = await app.inject({ method: "POST", url: "/api/v1/student/skills/platforms/leetcode", headers: { authorization: "Bearer student" },
      payload: { action: "visibility", visible: false } });
    assert.equal(hide.statusCode, 200, hide.body);
    assert.deepEqual((await db.query("SELECT reason FROM ranking.queue WHERE student_id=$1", [ids.R01])).rows, [{ reason: "student" }]);
    assert.ok(await recalc());
    const detail = await ok(`/placement/rankings/students/${ids.R01}`);
    assert.deepEqual([detail.score.statuses.dsa, detail.score.dsa, detail.score.statuses.developer], ["hidden", null, "pending"]);
    assert.ok(!(await ok("/placement/rankings?kind=dsa")).rows.some((r) => r.id === ids.R01));
    assert.ok(!detail.topics.some((x) => x.code.startsWith("dsa.") && x.score !== null), "hidden LeetCode topics are gone too");
    // A student can queue only their own record.
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [randomUUID()]);
    await assert.rejects(client.query("SELECT ranking.request_recalculation($1,'student')", [ids.R02]), /restricted/);
    await client.query("ROLLBACK");
  });

  await t.test("repositories synced before evidence existed show pending and are queued for a GitHub sync", async () => {
    await db.query("UPDATE student.github_repositories SET evidence='{}' WHERE student_id=$1", [ids.R07]);
    await workerTransaction(pool, (c) => c.query("SELECT ranking.request_recalculation($1,'sync')", [ids.R07]));
    assert.ok(await recalc());
    const detail = await ok(`/placement/rankings/students/${ids.R07}`);
    assert.deepEqual([detail.score.statuses.github, detail.score.github], ["pending", null]);
    assert.equal(await enqueueScheduled(pool, 168), 3, "each GitHub account not yet synced with evidence and organisation repositories, although synced today");
    assert.equal(await enqueueScheduled(pool, 168), 0, "queued once");
    const job = (await db.query("SELECT j.platform,j.reason FROM student.sync_jobs j WHERE j.student_id=$1", [ids.R07])).rows;
    assert.deepEqual(job, [{ platform: "github", reason: "scheduled" }]);
  });

  await t.test("only placement officers can read rankings; filters are validated", async () => {
    for (const who of ["student", "outsider"]) {
      assert.equal((await get("/placement/rankings", who)).statusCode, 403);
      assert.equal((await get("/placement/rankings/overview", who)).statusCode, 403);
      assert.equal((await get(`/placement/rankings/students/${ids.R01}`, who)).statusCode, 403);
    }
    assert.equal((await get("/placement/rankings?kind=everything")).statusCode, 400);
    assert.equal((await get("/placement/rankings?kind=topic")).statusCode, 400);
    assert.equal((await get("/placement/rankings?kind=topic&topic=core.dbms")).statusCode, 400, "unassessed subjects cannot be ranked");
    assert.equal((await get("/placement/rankings?limit=500")).statusCode, 400);
    assert.equal((await get("/placement/rankings?extra=1")).statusCode, 400);
    const body = JSON.stringify(await ok("/placement/rankings?kind=developer&show=all"));
    for (const secret of ["cipher", "token", "submitted"]) assert.ok(!body.includes(secret), "response leaked " + secret);
  });
});
