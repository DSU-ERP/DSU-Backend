import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withActor } from "../src/integrations/supabase/db.js";
import { testDatabase } from "./helpers/database.js";

const code = (expected) => (error) => {
  assert.equal(error.code, expected, error.message);
  return true;
};

// Batch 2027 fixture covering every category boundary, ties and unclassified rows.
const COHORT = [
  ["R01", "9.25", "CSE"],
  ["R02", "9.25", "ECE"],
  ["R03", "9.00", "CSE"],
  ["R04", "8.50", "ECE"],
  ["R05", "8.49", "CSE"],
  ["R06", "6.75", "CSE"],
  ["R07", "6.74", "ECE"],
  ["R08", null, "CSE"], // academics row with no CGPA
  ["R09", undefined, "CSE"], // no academics row at all
];

async function setup() {
  const { db, pool } = await testDatabase();
  const ids = {};
  for (const [usn, cgpa, dept] of COHORT) {
    ids[usn] = randomUUID();
    await db.query(
      "INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name,department_name,course_name,current_semester) VALUES($1,$2,$3,'2027','h',$4,$4||' Engineering','B.Tech','7')",
      [ids[usn], usn, "Name " + usn, dept],
    );
    if (cgpa !== undefined)
      await db.query("INSERT INTO erp.academics(student_id,cgpa,sgpa,attendance,current_backlog) VALUES($1,$2,8.1,91.5,0)", [ids[usn], cgpa]);
  }
  // A different batch must never influence 2027 ranks.
  ids.X01 = randomUUID();
  await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name) VALUES($1,'X01','Other Batch','2025','h','CSE')", [ids.X01]);
  await db.query("INSERT INTO erp.academics(student_id,cgpa) VALUES($1,9.9)", [ids.X01]);
  const users = { a: randomUUID(), b: randomUUID(), c: randomUUID(), officer: randomUUID(), outsider: randomUUID() };
  await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [Object.values(users)]);
  await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2),($3,'student',$4),($5,'student',$6)",
    [users.a, ids.R01, users.b, ids.R02, users.c, ids.R08]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [users.officer]);
  const as = (user, fn) => withActor(pool, users[user], fn);
  const call = (user, sql, values) => as(user, async (client) => (await client.query(sql, values)).rows[0]);
  const rpc = async (user, fn, q = {}) => (await call(user, `SELECT placement.${fn}($1::jsonb) AS r`, [JSON.stringify(q)])).r;
  // Worker transaction: app.sync_worker='on' and no actor.
  const worker = async (fn, { credentials = false } = {}) => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.sync_worker','on',true)");
      if (credentials) await client.query("SELECT set_config('app.credential_access','on',true)");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  return { db, pool, ids, users, as, call, rpc, worker };
}

test("student intelligence schema: ranks, officer reads, RLS and visibility", { timeout: 180000 }, async (t) => {
  const { db, ids, users, as, call, rpc, worker } = await setup();
  const usnOf = Object.fromEntries(Object.entries(ids).map(([usn, id]) => [id, usn]));

  await t.test("erp.cgpa_ranks dense ranks within batch and category", async () => {
    const { rows } = await db.query("SELECT * FROM erp.cgpa_ranks('2027')");
    const by = Object.fromEntries(rows.map((r) => [usnOf[r.student_id], r]));
    assert.equal(rows.length, 9);
    assert.deepEqual(["R01", "R02", "R03", "R04", "R05", "R06", "R07"].map((u) => by[u].batch_rank), [1, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(["R01", "R02", "R03", "R04"].map((u) => by[u].category_rank), [1, 1, 2, 3]);
    assert.deepEqual(["R05", "R06"].map((u) => by[u].category_rank), [1, 2]);
    assert.equal(by.R07.category_rank, 1);
    assert.deepEqual(["R04", "R05", "R06", "R07"].map((u) => by[u].category), ["advanced", "medium", "medium", "needs-improvement"]);
    for (const u of ["R08", "R09"]) {
      assert.equal(by[u].category, null);
      assert.equal(by[u].batch_rank, null);
      assert.equal(by[u].category_rank, null);
      assert.equal(by[u].category_size, null);
    }
    assert.equal(by.R01.batch_size, 7);
    assert.deepEqual([by.R01.category_size, by.R05.category_size, by.R07.category_size], [4, 2, 1]);
    const all = await db.query("SELECT * FROM erp.cgpa_ranks(NULL) WHERE student_id=$1", [ids.X01]);
    assert.equal(all.rows[0].batch_rank, 1);
    assert.equal(all.rows[0].batch_size, 1);
  });

  await t.test("student.my_ranking returns only the actor's own position", async () => {
    const mine = (await call("a", "SELECT student.my_ranking() AS r")).r;
    assert.deepEqual(mine, { batch: "2027", category: "advanced", batchRank: 1, categoryRank: 1, batchSize: 7, categorySize: 4, scope: "batch" });
    const unclassified = (await call("c", "SELECT student.my_ranking() AS r")).r;
    assert.equal(unclassified.category, null);
    assert.equal(unclassified.batchRank, null);
    await assert.rejects(call("outsider", "SELECT student.my_ranking()"), code("PT403"));
    await assert.rejects(call("officer", "SELECT student.my_ranking()"), code("PT403"));
    // Students cannot call the raw ranking function directly.
    await assert.rejects(call("a", "SELECT * FROM erp.cgpa_ranks('2027')"), code("42501"));
  });

  await t.test("ranked_students keeps global ranks under filters and pagination", async () => {
    const all = (await rpc("officer", "ranked_students", { category: "advanced" })).data;
    assert.equal(all.scope.batch, "2027"); // default batch: smallest >= current year
    assert.equal(all.scope.category, "advanced");
    assert.match(all.scope.rule, /Filters do not change ranks/);
    assert.deepEqual(all.rows.map((r) => r.usn), ["R01", "R02", "R03", "R04"]);
    assert.deepEqual(all.rows.map((r) => r.categoryRank), [1, 1, 2, 3]);
    assert.deepEqual(all.rows.map((r) => r.batchRank), [1, 1, 2, 3]);
    assert.equal(all.rows[3].cgpa, "8.50");
    assert.equal(all.rows[0].profileUrl, "/placement/students/" + ids.R01);
    assert.equal(all.rows[0].skillStatus, "not_started");
    assert.equal(all.rows[0].eligible, true);
    assert.deepEqual(all.pagination, { total: 4, page: 1, limit: 25 });

    const cse = (await rpc("officer", "ranked_students", { category: "advanced", department: "CSE" })).data;
    assert.deepEqual(cse.rows.map((r) => [r.usn, r.categoryRank]), [["R01", 1], ["R03", 2]]);
    const search = (await rpc("officer", "ranked_students", { category: "advanced", search: "r04" })).data;
    assert.deepEqual(search.rows.map((r) => [r.usn, r.categoryRank, r.batchRank]), [["R04", 3, 3]]);
    const medium = (await rpc("officer", "ranked_students", { category: "medium", batch: "2027" })).data;
    assert.deepEqual(medium.rows.map((r) => [r.usn, r.categoryRank, r.batchRank]), [["R05", 1, 4], ["R06", 2, 5]]);

    const page1 = (await rpc("officer", "ranked_students", { category: "advanced", limit: "2" })).data;
    const page2 = (await rpc("officer", "ranked_students", { category: "advanced", limit: "2", page: "2" })).data;
    assert.deepEqual(page1.rows.map((r) => r.usn), ["R01", "R02"]);
    assert.deepEqual(page2.rows.map((r) => [r.usn, r.categoryRank]), [["R03", 2], ["R04", 3]]);
    assert.equal(page1.pagination.total, 4);
    assert.equal(page2.pagination.total, 4);

    const byName = (await rpc("officer", "ranked_students", { category: "advanced", sort: "usn", direction: "desc" })).data;
    assert.deepEqual(byName.rows.map((r) => r.usn), ["R04", "R03", "R02", "R01"]);

    await db.query("INSERT INTO student.skill_profiles(student_id,onboarding_version) VALUES($1,student.onboarding_current_version()),($2,0)", [ids.R01, ids.R03]);
    // Version 2: complete needs the current version AND GitHub, LeetCode and LinkedIn LINKED.
    // Declaring "none" never satisfies a required platform, and HackerRank is optional.
    await db.query("INSERT INTO student.platform_accounts(student_id,platform,state) VALUES($1,'leetcode','linked'),($1,'hackerrank','declared_none'),($1,'linkedin','declared_none')", [ids.R01]);
    let complete = (await rpc("officer", "ranked_students", { category: "advanced", skill: "complete" })).data;
    assert.deepEqual(complete.rows, [], "GitHub not linked: not complete");
    assert.equal((await rpc("officer", "ranked_students", { category: "advanced", skill: "incomplete" })).data.rows.find((r) => r.usn === "R01").skillStatus, "incomplete");
    await db.query("INSERT INTO student.platform_accounts(student_id,platform,state) VALUES($1,'github','declared_none')", [ids.R01]);
    complete = (await rpc("officer", "ranked_students", { category: "advanced", skill: "complete" })).data;
    assert.deepEqual(complete.rows, [], "declared_none does not satisfy GitHub or LinkedIn");
    await db.query("UPDATE student.platform_accounts SET state='linked' WHERE student_id=$1 AND platform IN ('github','linkedin')", [ids.R01]);
    complete = (await rpc("officer", "ranked_students", { category: "advanced", skill: "complete" })).data;
    assert.deepEqual(complete.rows.map((r) => [r.usn, r.skillStatus]), [["R01", "complete"]]);
    // HackerRank is optional: removing it does not change the status.
    await db.query("DELETE FROM student.platform_accounts WHERE student_id=$1 AND platform='hackerrank'", [ids.R01]);
    assert.equal((await rpc("officer", "ranked_students", { category: "advanced", skill: "complete" })).data.rows.length, 1);
    // Disconnecting a required platform after completion makes the profile incomplete again.
    await db.query("UPDATE student.platform_accounts SET state='disconnected' WHERE student_id=$1 AND platform='github'", [ids.R01]);
    assert.deepEqual((await rpc("officer", "ranked_students", { category: "advanced", skill: "complete" })).data.rows, []);
    assert.equal((await call("officer", "SELECT placement.student_core($1) AS r", [ids.R01])).r.skillStatus, "incomplete");
    assert.deepEqual((await rpc("officer", "skill_students", { batch: "2027", status: "complete" })).data.rows, []);
    // The RLS test below expects R01 to start with no accounts; student_core re-adds the declarations.
    await db.query("DELETE FROM student.platform_accounts WHERE student_id=$1", [ids.R01]);
    const incomplete = (await rpc("officer", "ranked_students", { category: "advanced", skill: "incomplete" })).data;
    assert.deepEqual(incomplete.rows.map((r) => [r.usn, r.categoryRank]), [["R01", 1], ["R03", 2]]);
    const ineligible = (await rpc("officer", "ranked_students", { category: "needs-improvement", eligibility: "ineligible" })).data;
    assert.deepEqual(ineligible.rows.map((r) => r.usn), ["R07"]);

    await assert.rejects(rpc("a", "ranked_students", { category: "advanced" }), code("PT403"));
    await assert.rejects(rpc("officer", "ranked_students", { category: "elite" }), code("PT400"));
    await assert.rejects(rpc("officer", "ranked_students", {}), code("PT400"));
    await assert.rejects(rpc("officer", "ranked_students", { category: "advanced", limit: "101" }), code("PT400"));
    await assert.rejects(rpc("officer", "ranked_students", { category: "advanced", sort: "drop table" }), code("PT400"));

    for (let i = 0; i < 5; i++) {
      const exported = (await rpc("officer", "ranked_students", { category: "advanced", export: "true", limit: "2" })).data;
      assert.equal(exported.rows.length, 4);
    }
    const audited = await db.query("SELECT count(*)::int AS n FROM placement.events WHERE actor_id=$1 AND action='export' AND details->>'resource'='ranked_students'", [users.officer]);
    assert.equal(audited.rows[0].n, 5);
    await assert.rejects(rpc("officer", "ranked_students", { category: "advanced", export: "true" }), code("PT429"));
  });

  await t.test("category_cards totals and formatting", async () => {
    const cards = (await rpc("officer", "category_cards")).data;
    assert.equal(cards.batch, "2027");
    assert.deepEqual(cards.batches, ["2027", "2025"]);
    assert.deepEqual(cards.departments, ["CSE", "ECE"]);
    assert.equal(cards.total, 9);
    assert.equal(cards.unclassified, 2);
    assert.deepEqual(cards.cards.map((c) => c.id), ["advanced", "medium", "needs-improvement"]);
    const [adv, med, low] = cards.cards;
    assert.deepEqual([adv.total, adv.averageCgpa, adv.eligible, adv.cohortPercentage, adv.eligibilityPercentage], [4, "9.00", 4, 44.4, 100]);
    assert.deepEqual([med.total, med.averageCgpa, med.eligible, med.cohortPercentage], [2, "7.62", 2, 22.2]);
    assert.deepEqual([low.total, low.averageCgpa, low.eligible, low.eligibilityPercentage], [1, "6.74", 0, 0]);
    assert.equal(adv.range, "8.50 and above");
    const ece = (await rpc("officer", "category_cards", { department: "ECE" })).data;
    assert.equal(ece.total, 3);
    assert.equal(ece.cards[0].averageCgpa, "8.88"); // (9.25+8.50)/2 = 8.875
    const empty = (await rpc("officer", "category_cards", { department: "NONE" })).data;
    assert.equal(empty.total, 0);
    assert.equal(empty.cards[0].averageCgpa, null);
    assert.equal(empty.cards[0].eligibilityPercentage, null);
    await assert.rejects(rpc("a", "category_cards"), code("PT403"));
  });

  await t.test("overview_charts KPIs, status segments, progress and department filter", async () => {
    const before = (await rpc("officer", "overview_charts", { batch: "2027" })).data;
    assert.deepEqual(before.progress, []);
    assert.equal(before.kpis.totalStudents, 9);
    assert.equal(before.kpis.placed, 0);
    assert.equal(before.kpis.placementRate, 0);
    assert.equal(before.status.reduce((sum, s) => sum + s.count, 0), 9);

    const company = randomUUID(), done = randomUUID(), next = randomUUID();
    await db.query("INSERT INTO placement.companies(id,name) VALUES($1,'Acme')", [company]);
    await db.query(`INSERT INTO placement.drives(id,company_id,title,package_lpa,academic_year,batch,rounds,status,drive_date)
      VALUES($1,$3,'Done',6,'2026-27','2027','{HR}','completed',(date_trunc('month',now() AT TIME ZONE 'Asia/Kolkata')-interval '1 month'+interval '14 days')::date),
            ($2,$3,'Next',12,'2026-27','2027','{HR}','upcoming',NULL)`, [done, next, company]);
    const month = (k) => `(date_trunc('month',now() AT TIME ZONE 'Asia/Kolkata')-interval '${k} months'+interval '9 days') AT TIME ZONE 'Asia/Kolkata'`;
    const offer = async (drive, usn, status, when) => {
      const reg = randomUUID();
      await db.query("INSERT INTO placement.registrations(id,drive_id,student_id) VALUES($1,$2,$3)", [reg, drive, ids[usn]]);
      await db.query(`INSERT INTO placement.offers(registration_id,package_lpa,status,created_at) VALUES($1,6,$2,${month(when)})`, [reg, status]);
    };
    await offer(done, "R01", "accepted", 2);
    await offer(next, "R01", "offered", 0);
    await offer(done, "R05", "offered", 1);
    await offer(done, "R07", "declined", 1);
    await offer(next, "R03", "revoked", 0);

    const after = (await rpc("officer", "overview_charts", { batch: "2027" })).data;
    const k = after.kpis;
    assert.deepEqual([k.totalStudents, k.eligible, k.placed, k.eligiblePlaced, k.acceptedOffers, k.activeOffers, k.companies, k.activeDrives],
      [9, 6, 2, 2, 1, 3, 1, 1]);
    assert.equal(k.placementRate, 22.22);
    assert.equal(k.eligiblePlacementRate, 33.33);
    assert.equal(k.averageCgpa, "8.28"); // mean of 7 valid CGPAs = 57.98/7
    const status = Object.fromEntries(after.status.map((s) => [s.key, s.count]));
    assert.deepEqual(status, { placed: 2, eligible_not_placed: 4, not_eligible_not_placed: 1, unknown_not_placed: 2 });
    assert.equal(after.status.reduce((sum, s) => sum + s.count, 0), k.totalStudents);
    assert.equal(after.progress.length, 3);
    assert.deepEqual(after.progress.map((p) => [p.studentsPlaced, p.offersRecorded, p.drivesCompleted]), [[1, 1, 0], [1, 2, 1], [0, 2, 0]]);
    assert.match(after.progress[0].month, /^\d{4}-\d{2}$/);
    assert.match(after.definitions.progress, /month an offer was recorded in the ERP/);
    assert.ok(!JSON.stringify(after.definitions).includes("—"), "no em dashes");

    const cse = (await rpc("officer", "overview_charts", { batch: "2027", department: "CSE" })).data;
    assert.equal(cse.kpis.totalStudents, 6);
    assert.equal(cse.kpis.placed, 2);
    assert.equal(cse.kpis.activeOffers, 3); // R01 twice, R05 once
    assert.equal(cse.kpis.companies, 1); // drives ignore the department filter
    assert.deepEqual(cse.departments, [{ department: "CSE", total: 6, eligible: 4, placed: 2 }]);
    assert.equal(cse.status.reduce((sum, s) => sum + s.count, 0), 6);
    const everyone = (await rpc("officer", "overview_charts")).data;
    assert.equal(everyone.kpis.totalStudents, 10);
    assert.equal(everyone.departments.reduce((sum, d) => sum + d.total, 0), 10);
    await assert.rejects(rpc("b", "overview_charts"), code("PT403"));
  });

  await t.test("RLS isolates students, credentials and the worker", async () => {
    const accountA = randomUUID(), accountB = randomUUID();
    await as("a", (c) => c.query("INSERT INTO student.platform_accounts(id,student_id,platform,state,handle) VALUES($1,$2,'github','linked','alice')", [accountA, ids.R01]));
    await as("b", (c) => c.query("INSERT INTO student.platform_accounts(id,student_id,platform,state,handle) VALUES($1,$2,'github','linked','bob')", [accountB, ids.R02]));
    await as("b", (c) => c.query("INSERT INTO student.skill_profiles(student_id) VALUES($1)", [ids.R02]));

    assert.deepEqual((await as("a", (c) => c.query("SELECT id FROM student.platform_accounts"))).rows.map((r) => r.id), [accountA]);
    assert.deepEqual((await as("a", (c) => c.query("SELECT student_id FROM student.skill_profiles"))).rows.map((r) => r.student_id), [ids.R01]);
    await assert.rejects(as("a", (c) => c.query("INSERT INTO student.platform_accounts(student_id,platform,state) VALUES($1,'leetcode','declared_none')", [ids.R02])), code("42501"));
    await assert.rejects(as("a", (c) => c.query("INSERT INTO student.skill_profiles(student_id) VALUES($1)", [ids.R03])), code("42501"));
    const hijack = await as("a", (c) => c.query("UPDATE student.platform_accounts SET handle='mallory' WHERE id=$1", [accountB]));
    assert.equal(hijack.affectedRows ?? hijack.rowCount, 0);
    const wipe = await as("a", (c) => c.query("DELETE FROM student.skill_profiles WHERE student_id=$1", [ids.R02]));
    assert.equal(wipe.affectedRows ?? wipe.rowCount, 0);

    await db.query("INSERT INTO student.github_repositories(account_id,repo_id,student_id,full_name,name,url) VALUES($1,1,$2,'bob/one','one','https://github.com/bob/one')", [accountB, ids.R02]);
    await db.query("INSERT INTO student.featured_projects(student_id,position,account_id,repo_id) VALUES($1,1,$2,1)", [ids.R02, accountB]);
    assert.equal((await as("a", (c) => c.query("SELECT * FROM student.featured_projects"))).rows.length, 0);
    assert.equal((await as("a", (c) => c.query("SELECT * FROM student.github_repositories"))).rows.length, 0);
    // The owner-checked cleanup refuses another student's account and leaves its data alone.
    await assert.rejects(as("a", (c) => c.query("SELECT student.clear_platform_data($1::uuid)", [accountB])), code("PT404"));
    assert.equal((await db.query("SELECT count(*)::int n FROM student.github_repositories WHERE account_id=$1", [accountB])).rows[0].n, 1);
    await assert.rejects(as("a", (c) => c.query("INSERT INTO student.featured_projects(student_id,position,account_id,repo_id) VALUES($1,2,$2,1)", [ids.R02, accountB])), code("42501"));
    // A student can never point a featured row at another student's repository.
    await assert.rejects(as("a", (c) => c.query("INSERT INTO student.featured_projects(student_id,position,account_id,repo_id) VALUES($1,1,$2,1)", [ids.R01, accountB])));
    // Students cannot write platform-verified metrics.
    await assert.rejects(as("a", (c) => c.query("INSERT INTO student.platform_metrics(account_id,metric,student_id,platform,value,verification,method) VALUES($1,'repos.public',$2,'github','5','platform_verified','x')", [accountA, ids.R01])), code("42501"));

    // Credentials: the owner writes ciphertext, but nobody reads it without app.credential_access.
    await as("a", (c) => c.query("INSERT INTO student.platform_credentials(account_id,kind,key_id,access_cipher) VALUES($1,'github_pat','k1','cipher-a')", [accountA]));
    await assert.rejects(as("b", (c) => c.query("INSERT INTO student.platform_credentials(account_id,kind,key_id,access_cipher) VALUES($1,'github_pat','k1','evil')", [accountA])), code("42501"));
    await db.query("INSERT INTO student.platform_credentials(account_id,kind,key_id,access_cipher) VALUES($1,'github_user_token','k1','cipher-b')", [accountB]);
    const read = (user, on) => as(user, async (c) => {
      if (on) await c.query("SELECT set_config('app.credential_access','on',true)");
      return (await c.query("SELECT account_id,access_cipher FROM student.platform_credentials")).rows;
    });
    assert.equal((await read("a", false)).length, 0);
    assert.deepEqual(await read("a", true), [{ account_id: accountA, access_cipher: "cipher-a" }]);
    assert.deepEqual((await read("b", true)).map((r) => r.access_cipher), ["cipher-b"]);
    assert.equal((await read("officer", true)).length, 0);
    assert.equal((await read("outsider", true)).length, 0);

    // OAuth state is private to the user.
    await as("a", (c) => c.query("INSERT INTO student.oauth_states(state_hash,user_id,student_id,verifier_cipher,expires_at) VALUES($1,$2,$3,'v',now()+interval '10 minutes')", ["s".repeat(64), users.a, ids.R01]));
    assert.equal((await as("b", (c) => c.query("SELECT * FROM student.oauth_states"))).rows.length, 0);
    assert.equal((await as("a", (c) => c.query("SELECT * FROM student.oauth_states"))).rows.length, 1);
    assert.equal((await as("officer", (c) => c.query("SELECT * FROM student.oauth_states"))).rows.length, 0);
    // dsu_placement itself holds no privilege on credentials or OAuth state.
    const officerRole = (await db.query("SELECT has_table_privilege('dsu_placement','student.platform_credentials','SELECT') AS creds,has_table_privilege('dsu_placement','student.oauth_states','SELECT') AS oauth,has_function_privilege('authenticated','placement.ranked_students(jsonb)','EXECUTE') AS browser")).rows[0];
    assert.deepEqual(officerRole, { creds: false, oauth: false, browser: false });
    await assert.rejects(as("b", (c) => c.query("INSERT INTO student.oauth_states(state_hash,user_id,student_id,verifier_cipher,expires_at) VALUES($1,$2,$3,'v',now())", ["t".repeat(64), users.a, ids.R01])), code("42501"));

    // Worker: reads every account, writes metrics and jobs for any student.
    await worker(async (c) => {
      assert.equal((await c.query("SELECT id FROM student.platform_accounts")).rows.length, 2);
      assert.equal((await c.query("SELECT * FROM student.platform_credentials")).rows.length, 0);
      await c.query("INSERT INTO student.platform_metrics(account_id,metric,student_id,platform,value,verification,method) VALUES($1,'repos.public',$2,'github','12','platform_verified','github_api'),($1,'activity.commits_90d',$2,'github','40','platform_verified','github_api')", [accountB, ids.R02]);
      await c.query("UPDATE student.platform_accounts SET sync_status='completed',last_synced_at=now() WHERE id=$1", [accountB]);
      await c.query("INSERT INTO student.sync_jobs(account_id,student_id,platform,reason) VALUES($1,$2,'github','scheduled')", [accountA, ids.R01]);
    });
    assert.equal((await worker((c) => c.query("SELECT * FROM student.platform_credentials"), { credentials: true })).rows.length, 2);
    await assert.rejects(worker((c) => c.query("INSERT INTO student.sync_jobs(account_id,student_id,platform,reason) VALUES($1,$2,'github','manual')", [accountA, ids.R01])), code("23505"));
    assert.equal((await as("a", (c) => c.query("SELECT * FROM student.sync_jobs"))).rows.length, 1);
    assert.equal((await as("b", (c) => c.query("SELECT * FROM student.sync_jobs"))).rows.length, 0);
    assert.equal((await as("b", (c) => c.query("SELECT * FROM student.platform_metrics"))).rows.length, 2);
    assert.equal((await as("a", (c) => c.query("SELECT * FROM student.platform_metrics"))).rows.length, 0);
  });

  await t.test("skill_profile honours visibility and never leaks contacts", async () => {
    const accountB = (await db.query("SELECT id FROM student.platform_accounts WHERE student_id=$1 AND platform='github'", [ids.R02])).rows[0].id;
    await db.query("UPDATE student.platform_accounts SET profile_url='https://github.com/bob',ownership='platform_verified',auth_method='github_app' WHERE id=$1", [accountB]);
    await db.query("INSERT INTO student.platform_accounts(student_id,platform,state) VALUES($1,'leetcode','declared_none')", [ids.R02]);
    await db.query("INSERT INTO student.platform_accounts(student_id,platform,state,handle,visible) VALUES($1,'kaggle','linked','hidden-kaggle',false)", [ids.R02]);
    await db.query(`INSERT INTO student.platform_accounts(student_id,platform,state,handle,profile_url,submitted) VALUES($1,'hackerrank','linked','bobhr','https://www.hackerrank.com/profile/bobhr',
      '{"certifications":[{"name":"SQL","url":"https://www.hackerrank.com/certificates/abc123"}]}')`, [ids.R02]);
    await db.query("UPDATE student.github_repositories SET pinned=true,pin_order=1,recommendation_score=50 WHERE account_id=$1 AND repo_id=1", [accountB]);
    await db.query("INSERT INTO student.github_repositories(account_id,repo_id,student_id,full_name,name,url,recommendation_score,recommendation_reasons) VALUES($1,2,$2,'bob/two','two','https://github.com/bob/two',90,'[\"Has a README\"]')", [accountB, ids.R02]);
    await db.query("UPDATE student.featured_projects SET repo_id=2 WHERE student_id=$1", [ids.R02]);
    const visible = randomUUID();
    await db.query("INSERT INTO student.profile_summaries(id,student_id,model,content,input_hash,created_at) VALUES($1,$2,'m','{\"text\":\"ok\"}','h1',now()-interval '1 day')", [visible, ids.R02]);
    await db.query("INSERT INTO student.profile_summaries(student_id,model,content,input_hash,hidden) VALUES($1,'m','{\"text\":\"hidden\"}','h2',true)", [ids.R02]);
    await db.query("INSERT INTO erp.contacts(student_id,details) VALUES($1,'{\"email\":\"secret-b@example.com\",\"phoneStudent1\":\"9999999999\",\"fatherName\":\"Parent B\"}')", [ids.R02]);

    const profile = async (purpose, user = "officer") => (await call(user, "SELECT placement.skill_profile($1,$2) AS r", [ids.R02, purpose])).r;
    // Before consent (given at onboarding completion) officers see only onboarding
    // status and per-platform state: no handles, urls, metrics, submitted figures,
    // projects, activity or summary.
    for (const purpose of ["officer", "ai"]) {
      const early = await profile(purpose);
      assert.deepEqual(early.accounts, [{ platform: "github", state: "linked" }, { platform: "leetcode", state: "declared_none" }, { platform: "hackerrank", state: "linked" }]);
      assert.deepEqual([early.featured, early.repositories, early.activity, early.summary, early.summaryWithheld], [[], [], [], null, false]);
      assert.equal(early.onboarding.consented, false);
      for (const leak of ["bob", "abc123", "github.com", "ok"]) assert.ok(!JSON.stringify(early.accounts).includes(leak), leak);
    }
    await db.query("UPDATE student.skill_profiles SET consent_version=1,consented_at=now() WHERE student_id=$1", [ids.R02]);
    const officer = await profile("officer");
    assert.equal(officer.onboarding.consented, true);
    assert.deepEqual(officer.accounts.map((a) => a.platform), ["github", "leetcode", "hackerrank"]); // kaggle hidden by the student
    assert.deepEqual(officer.accounts[1], { platform: "leetcode", state: "declared_none" });
    const github = officer.accounts[0];
    assert.equal(github.profileUrl, "https://github.com/bob");
    assert.deepEqual(github.metrics.map((m) => m.metric), ["repos.public"]);
    assert.equal(github.metrics[0].verification, "platform_verified");
    assert.deepEqual(officer.activity.map((m) => m.metric), ["activity.commits_90d"]);
    assert.deepEqual(officer.featured.map((f) => [f.position, f.source, f.repo.name]), [[1, "github_pinned", "one"], [2, "student_selected", "two"]]);
    assert.deepEqual(officer.repositories.map((r) => r.name), ["two", "one"]);
    assert.deepEqual(officer.repositories[0].recommendationReasons, ["Has a README"]);
    assert.equal(officer.summary.id, visible);
    assert.equal(officer.onboarding.complete, false);
    assert.deepEqual(officer.visibility, { platforms: true, projects: true, activity: true, summary: true });
    assert.equal(officer.accounts[2].submitted.certifications[0].url, "https://www.hackerrank.com/certificates/abc123");

    const ai = await profile("ai");
    const text = JSON.stringify(ai);
    for (const secret of ["secret-b@example.com", "9999999999", "Parent B", "certificates/abc123", "github.com/bob/one"])
      assert.ok(!text.includes(secret), "ai profile leaked " + secret);
    assert.equal(ai.accounts[0].profileUrl, "https://github.com/bob");
    assert.equal(ai.featured[0].repo.url, undefined);

    // A summary is withheld as soon as any evidence group it used stops being shared.
    const grounded = randomUUID();
    await db.query("INSERT INTO student.profile_summaries(id,student_id,model,content,input_hash,sources) VALUES($1,$2,'m','{\"text\":\"bobhr\"}','h3','[\"platforms:hackerrank\",\"projects\",\"activity\"]')", [grounded, ids.R02]);
    const shown = await profile("officer");
    assert.deepEqual([shown.summary.id, shown.summaryWithheld], [grounded, false]);
    const withheld = async (change, undo) => {
      await db.query(change, [ids.R02]);
      const view = await profile("officer");
      assert.deepEqual([view.summary, view.summaryWithheld], [null, true], change);
      assert.equal((await profile("ai")).summary, null, change);
      await db.query(undo, [ids.R02]);
      assert.equal((await profile("officer")).summary.id, grounded);
    };
    await withheld("UPDATE student.platform_accounts SET visible=false WHERE student_id=$1 AND platform='hackerrank'",
      "UPDATE student.platform_accounts SET visible=true WHERE student_id=$1 AND platform='hackerrank'");
    await withheld("UPDATE student.platform_accounts SET state='disconnected' WHERE student_id=$1 AND platform='hackerrank'",
      "UPDATE student.platform_accounts SET state='linked' WHERE student_id=$1 AND platform='hackerrank'");
    await withheld("UPDATE student.skill_profiles SET visibility=visibility||'{\"platforms\":false}' WHERE student_id=$1",
      "UPDATE student.skill_profiles SET visibility=visibility||'{\"platforms\":true}' WHERE student_id=$1");
    await withheld("UPDATE student.skill_profiles SET visibility=visibility||'{\"projects\":false}' WHERE student_id=$1",
      "UPDATE student.skill_profiles SET visibility=visibility||'{\"projects\":true}' WHERE student_id=$1");
    await withheld("UPDATE student.skill_profiles SET visibility=visibility||'{\"activity\":false}' WHERE student_id=$1",
      "UPDATE student.skill_profiles SET visibility=visibility||'{\"activity\":true}' WHERE student_id=$1");
    await withheld("UPDATE student.platform_accounts SET visible=false WHERE student_id=$1 AND platform='github'",
      "UPDATE student.platform_accounts SET visible=true WHERE student_id=$1 AND platform='github'");
    // Hiding an unrelated account (Kaggle is already hidden) does not withhold it; unknown groups fail closed.
    await db.query("UPDATE student.profile_summaries SET sources='[\"platforms:hackerrank\",\"bogus\"]' WHERE id=$1", [grounded]);
    assert.equal((await profile("officer")).summaryWithheld, true);
    await db.query("DELETE FROM student.profile_summaries WHERE id=$1", [grounded]);

    await db.query("UPDATE student.skill_profiles SET visibility='{\"platforms\":false,\"projects\":false,\"activity\":false,\"summary\":false}' WHERE student_id=$1", [ids.R02]);
    const hidden = await profile("officer");
    assert.deepEqual(hidden.accounts, [{ platform: "github", state: "linked" }, { platform: "leetcode", state: "declared_none" }, { platform: "hackerrank", state: "linked" }]);
    assert.deepEqual([hidden.featured, hidden.repositories, hidden.activity, hidden.summary], [[], [], [], null]);

    await db.query("UPDATE student.skill_profiles SET visibility=visibility||'{\"summary\":true}' WHERE student_id=$1", [ids.R02]);
    await db.query("UPDATE student.profile_summaries SET hidden=true WHERE id=$1", [visible]);
    assert.equal((await profile("officer")).summary, null);

    await assert.rejects(profile("marketing"), code("PT400"));
    await assert.rejects(profile("officer", "a"), code("PT403"));
    await assert.rejects(call("officer", "SELECT placement.skill_profile($1,'officer')", [randomUUID()]), code("PT404"));
  });

  await t.test("student_core is consistent with cgpa_ranks and has no contact data", async () => {
    const core = (await call("officer", "SELECT placement.student_core($1) AS r", [ids.R02])).r;
    const text = JSON.stringify(core);
    for (const secret of ["secret-b@example.com", "9999999999", "Parent B"]) assert.ok(!text.includes(secret));
    assert.equal(core.usn, "R02");
    assert.equal(core.cgpa, "9.25");
    assert.equal(core.attendance, "91.5");
    assert.equal(core.category, "advanced");
    assert.equal(core.categoryLabel, "Advanced");
    assert.equal(core.program, "B.Tech");
    assert.equal(core.provenance, "institution_verified");
    const rank = (await db.query("SELECT * FROM erp.cgpa_ranks('2027') WHERE student_id=$1", [ids.R02])).rows[0];
    assert.deepEqual(core.ranking, { batchRank: rank.batch_rank, categoryRank: rank.category_rank, batchSize: rank.batch_size, categorySize: rank.category_size, scope: "batch" });
    const placed = (await call("officer", "SELECT placement.student_core($1) AS r", [ids.R01])).r;
    assert.deepEqual(placed.placement, { activeOffers: 2, acceptedOffers: 1, highestPackageLpa: "6", placed: true });
    // R01 has GitHub linked (RLS test) but LeetCode and LinkedIn are not linked yet.
    assert.equal(placed.skillStatus, "incomplete");
    await db.query("INSERT INTO student.platform_accounts(student_id,platform,state) VALUES($1,'leetcode','linked'),($1,'linkedin','linked')", [ids.R01]);
    assert.equal((await call("officer", "SELECT placement.student_core($1) AS r", [ids.R01])).r.skillStatus, "complete");
    await assert.rejects(call("officer", "SELECT placement.student_core($1)", [randomUUID()]), code("PT404"));
    await assert.rejects(call("b", "SELECT placement.student_core($1)", [ids.R02]), code("PT403"));
  });

  await t.test("lookup_students and skill_students", async () => {
    const exact = (await rpc("officer", "lookup_students", { usn: " r03 " })).data;
    assert.equal(exact.exact, true);
    assert.deepEqual(exact.matches.map((m) => m.usn), ["R03"]);
    assert.equal(exact.matches[0].profileUrl, "/placement/students/" + ids.R03);
    const named = (await rpc("officer", "lookup_students", { name: "name r0" })).data;
    assert.equal(named.exact, false);
    assert.equal(named.matches.length, 9);
    const both = (await rpc("officer", "lookup_students", { usn: "R05", name: "name r" })).data;
    assert.equal(both.matches[0].usn, "R05");
    assert.equal(both.matches.length, 9);
    await assert.rejects(rpc("officer", "lookup_students", {}), code("PT400"));
    await assert.rejects(rpc("officer", "lookup_students", { name: "ab" }), code("PT400"));

    await db.query("UPDATE student.skill_profiles SET onboarding_completed_at=now() WHERE student_id=$1", [ids.R01]);
    // No consent recorded yet: linked platforms are not shared.
    const early = (await rpc("officer", "skill_students", { batch: "2027" })).data;
    assert.deepEqual(early.rows.map((r) => [r.usn, r.skillStatus, r.linkedPlatforms]), [["R01", "complete", []]]);
    await db.query("UPDATE student.skill_profiles SET consent_version=1,consented_at=now() WHERE student_id=$1", [ids.R01]);
    const done = (await rpc("officer", "skill_students", { batch: "2027" })).data;
    assert.deepEqual(done.rows.map((r) => [r.usn, r.skillStatus, r.linkedPlatforms]), [["R01", "complete", ["github", "leetcode", "linkedin"]]]);
    // Hidden accounts are never listed.
    await db.query("UPDATE student.platform_accounts SET visible=false WHERE student_id=$1 AND platform='github'", [ids.R01]);
    assert.deepEqual((await rpc("officer", "skill_students", { batch: "2027" })).data.rows[0].linkedPlatforms, ["leetcode", "linkedin"]);
    await db.query("UPDATE student.platform_accounts SET visible=true WHERE student_id=$1 AND platform='github'", [ids.R01]);
    assert.ok(done.rows[0].completedAt);
    assert.equal(done.rows[0].cgpa, "9.25");
    const notStarted = (await rpc("officer", "skill_students", { status: "not_started", limit: "3" })).data;
    assert.equal(notStarted.rows.length, 3);
    assert.equal(notStarted.pagination.total, 7); // 10 students minus R01 (complete), R02 and R03 (incomplete)
    await assert.rejects(rpc("officer", "skill_students", { status: "done" }), code("PT400"));
  });
});
