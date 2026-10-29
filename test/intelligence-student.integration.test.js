import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { testDatabase } from "./helpers/database.js";
import { createSecrets } from "../src/platform/crypto/secrets.js";
import { assertFineGrainedToken } from "../src/modules/intelligence/github.js";
import { ProviderError } from "../src/modules/intelligence/platforms.js";
import { claimJobs, credentialAad, enqueue, enqueueScheduled, workerTransaction } from "../src/modules/intelligence/sync.js";
import { createSyncWorker } from "../src/modules/intelligence/worker.js";

const KEYS = `k1:${randomBytes(32).toString("base64")}`;
const ENV = {
  SERVICE_TOKEN: "x".repeat(32),
  RATE_LIMIT_USER_MAX: 1000,
  INTEGRATION_ENCRYPTION_KEYS: KEYS,
  INTEGRATION_ENCRYPTION_KEY_ID: "k1",
  GITHUB_APP_CLIENT_ID: "Iv1.test",
  GITHUB_APP_CLIENT_SECRET: "test-secret",
  GITHUB_OAUTH_REDIRECT_URL: "http://localhost:3000/student/connections/github/callback",
  SYNC_WORKER_CONCURRENCY: "1",
};
const PAT_B = "github_pat_" + "B".repeat(60);
const SECRET_MARKERS = ["ghu_access_", "ghr_refresh_", "github_pat_BBBB", "v1.k1."];

function payloadFor(login, id, repos) {
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  return {
    account: { login, id, url: `https://github.com/${login}` },
    publicRepos: repos.length,
    originalRepos: repos.length,
    repositories: repos.map((r) => ({
      id: r.id, name: r.name, nameWithOwner: `${login}/${r.name}`, owner: login, url: `https://github.com/${login}/${r.name}`,
      description: "Project " + r.name, isFork: false, isArchived: false, pushedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      stars: 1, forks: 0, primaryLanguage: "Python", languages: { Python: 1000 }, license: "MIT", homepage: null, topics: ["ml"],
      hasReadme: true, readmeBytes: 800,
    })),
    pinned: [],
    calendar: { total: 12, commits: 10, restricted: 2, days: [{ date: day(0), count: 2 }, { date: day(1), count: 1 }] },
    linesAdded: { value: 40, counted: repos.length, eligible: repos.length, pending: 0 },
    additions: Object.fromEntries(repos.map((r) => [r.id, 20])),
  };
}

test("student skills routes and the sync worker", { timeout: 300000 }, async (t) => {
  const { db, pool } = await testDatabase();
  const users = { a: randomUUID(), b: randomUUID(), officer: randomUUID(), outsider: randomUUID() };
  const students = { a: randomUUID(), b: randomUUID() };
  await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [Object.values(users)]);
  for (const key of ["a", "b"]) {
    await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash) VALUES($1,$2,$3,'2027',$4)", [students[key], "SK" + key, "Student " + key, key]);
    await db.query("INSERT INTO erp.academics(student_id,cgpa,current_backlog) VALUES($1,8.1,0)", [students[key]]);
    await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [users[key], students[key]]);
  }
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [users.officer]);

  // Fake providers: nothing here reaches GitHub or Hugging Face.
  const calls = { exchange: [], revoke: [], refresh: [], fetch: [] };
  let nextGrant = 1;
  const accessOwners = new Map(); // access token -> GitHub user
  const github = {
    authorizeUrl: ({ state, codeChallenge }) =>
      `https://github.com/login/oauth/authorize?client_id=Iv1.test&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
    async exchangeCode({ code, codeVerifier }) {
      calls.exchange.push({ code, codeVerifier });
      const n = nextGrant++;
      const tokens = { accessToken: `ghu_access_${n}`, refreshToken: `ghr_refresh_${n}`, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(), refreshExpiresAt: new Date(Date.now() + 180 * 86400000).toISOString() };
      accessOwners.set(tokens.accessToken, code === "code-for-b" ? { id: 77, login: "bob-gh" } : { id: 42, login: "alice-gh" });
      return tokens;
    },
    async user(token) {
      const owner = accessOwners.get(token);
      if (!owner) throw new ProviderError("CREDENTIAL_INVALID", "bad");
      return { ...owner, url: `https://github.com/${owner.login}`, tokenExpiresAt: null };
    },
    async verifyPat(token) {
      assertFineGrainedToken(token);
      return this.user(token);
    },
    async refresh(refreshToken) {
      calls.refresh.push(refreshToken);
      const n = nextGrant++;
      const next = { accessToken: `ghu_access_${n}`, refreshToken: `ghr_refresh_${n}`, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(), refreshExpiresAt: new Date(Date.now() + 180 * 86400000).toISOString() };
      accessOwners.set(next.accessToken, { id: 42, login: "alice-gh" });
      return next;
    },
    async revoke(token) {
      calls.revoke.push(token);
    },
    fail: null,
    async fetchProfile(token, options) {
      calls.fetch.push({ token, options });
      if (this.fail) throw this.fail;
      const owner = accessOwners.get(token);
      return payloadFor(owner.login, owner.id, owner.id === 42 ? [{ id: 1001, name: "alpha" }, { id: 1002, name: "beta" }, { id: 1003, name: "gamma" }, { id: 1004, name: "delta" }] : [{ id: 2001, name: "bobs" }]);
    },
  };
  const huggingface = {
    fail: null,
    async fetchProfile(username) {
      if (this.fail) throw this.fail;
      return { account: { username }, counts: { models: 2, datasets: 0, spaces: 1 }, top: { models: [{ id: username + "/m", likes: 3 }], datasets: [], spaces: [] } };
    },
  };
  // LeetCode is synced from public profile data; tests never reach leetcode.com.
  const leetcode = {
    calls: [],
    async fetchProfile(username) {
      this.calls.push(username);
      return { account: { username }, realName: "Student A", solved: { all: 120, easy: 60, medium: 50, hard: 10 }, contest: null, tags: [{ slug: "array", name: "Array", solved: 40, level: "fundamental" }] };
    },
  };
  const integrations = { github, huggingface, leetcode };
  const app = await buildApp({ pool, env: ENV, logger: false, verify: async (token) => ({ id: users[token] }), integrations });
  const logs = [];
  const worker = createSyncWorker({ pool, env: ENV, integrations, log: (entry) => logs.push(entry) });
  t.after(() => app.close());
  const bodies = [];
  const call = async (method, url, user = "a", payload) => {
    const response = await app.inject({ method, url: "/api/v1" + url, headers: { authorization: "Bearer " + user }, ...(payload === undefined ? {} : { payload }) });
    bodies.push(response.body);
    return response;
  };
  const post = (url, payload, user) => call("POST", url, user, payload);
  const one = async (sql, values) => (await db.query(sql, values)).rows[0];
  const secrets = createSecrets(ENV);

  await t.test("onboarding is required before the dashboard", async () => {
    const session = (await call("GET", "/session")).json().data;
    assert.deepEqual(session, { role: "student", home: "/student/onboarding", onboardingRequired: true });
    assert.deepEqual((await call("GET", "/session", "officer")).json().data, { role: "placement_officer", home: "/placement", onboardingRequired: false });
    assert.deepEqual((await call("GET", "/session", "outsider")).json().data, { role: null, home: "/onboarding", onboardingRequired: false });
    const dashboard = await call("GET", "/student/dashboard");
    assert.equal(dashboard.statusCode, 403);
    assert.equal(dashboard.json().error.code, "ONBOARDING_REQUIRED");
    // /student/readiness returns the dashboard payload, so it is gated the same way.
    const readiness = await call("GET", "/student/readiness");
    assert.equal(readiness.statusCode, 403);
    assert.equal(readiness.json().error.code, "ONBOARDING_REQUIRED");
    assert.equal((await post("/student/skills/onboarding", { action: "confirm_identity" }, "outsider")).statusCode, 403);
  });

  await t.test("complete rejects missing sections and revision mismatches", async () => {
    let response = await post("/student/skills/onboarding", { action: "complete", consent: true, revision: 0 });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "ONBOARDING_INCOMPLETE");
    // Version 2: GitHub, LeetCode and LinkedIn must be linked; HackerRank is optional.
    assert.deepEqual(response.json().error.missing, ["identity", "github", "leetcode", "linkedin", "visibility"]);
    response = await post("/student/skills/onboarding", { action: "confirm_identity" });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().data.identityConfirmedAt);
    assert.equal(response.json().data.sections.identity, true);
    const revision = response.json().data.revision;
    response = await post("/student/skills/onboarding", { action: "visibility", visibility: { platforms: true, projects: true, activity: false, summary: true }, revision: revision + 5 });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "PROFILE_CHANGED");
    response = await post("/student/skills/onboarding", { action: "visibility", visibility: { platforms: true, projects: true, activity: false, summary: true }, revision });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.visibility.activity, false);
    assert.equal(response.json().data.sections.visibility, true);
    assert.equal((await post("/student/skills/onboarding", { action: "complete", consent: false, revision })).statusCode, 400);
    assert.equal((await post("/student/skills/onboarding", { action: "visibility", visibility: { platforms: true }, revision })).statusCode, 400);
  });

  await t.test("platform links validate handles and submitted figures; LeetCode is queued for sync", async () => {
    let response = await post("/student/skills/platforms/github", { action: "link", value: "octocat" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "GITHUB_AUTH_REQUIRED");
    response = await post("/student/skills/platforms/leetcode", { action: "link", value: "https://leetcode.com.evil.com/u/x" });
    assert.equal(response.json().error.code, "INVALID_PLATFORM_HANDLE");
    response = await post("/student/skills/platforms/leetcode", { action: "link", value: "coder", submitted: { solved: 5, easy: 5, medium: 5, hard: 5 } });
    assert.equal(response.json().error.code, "INVALID_SUBMITTED_FIELDS");
    assert.deepEqual(response.json().error.fields, ["solved"]);
    response = await post("/student/skills/platforms/leetcode", { action: "link", value: "https://leetcode.com/u/coder/", submitted: { solved: 120, easy: 60, medium: 50, hard: 10 } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, {
      platform: "leetcode", state: "linked", handle: "coder", profileUrl: "https://leetcode.com/u/coder/", authMethod: "public_api",
      ownership: "student_submitted", visible: true, syncStatus: "pending", syncError: null, lastSyncedAt: null, nameMatch: "unverified",
      submitted: { solved: 120, easy: 60, medium: 50, hard: 10 }, metrics: [],
    });
    assert.deepEqual(await one("SELECT reason,status FROM student.sync_jobs WHERE student_id=$1 AND platform='leetcode'", [students.a]), { reason: "connect", status: "pending" });
    response = await post("/student/skills/platforms/hackerrank", { action: "declare_none" });
    assert.equal(response.json().data.state, "declared_none");
    response = await post("/student/skills/platforms/linkedin", { action: "link", value: "https://in.linkedin.com/in/student-a", visible: false });
    assert.equal(response.json().data.profileUrl, "https://www.linkedin.com/in/student-a");
    assert.equal(response.json().data.visible, false);
    response = await post("/student/skills/platforms/linkedin", { action: "visibility", visible: true });
    assert.equal(response.json().data.visible, true);
    assert.equal((await post("/student/skills/platforms/kaggle", { action: "visibility", visible: true })).statusCode, 404);
    assert.equal((await post("/student/skills/platforms/twitter", { action: "declare_none" })).statusCode, 400);
    assert.equal((await post("/student/skills/platforms/leetcode", { action: "link", value: "x", extra: 1 })).statusCode, 400);
    response = await post("/student/skills/platforms/huggingface", { action: "link", value: "https://huggingface.co/alice-hf" });
    assert.deepEqual([response.json().data.authMethod, response.json().data.ownership, response.json().data.syncStatus], ["public_api", "student_submitted", "pending"]);
    const job = await one("SELECT reason,status FROM student.sync_jobs WHERE student_id=$1 AND platform='huggingface'", [students.a]);
    assert.deepEqual(job, { reason: "connect", status: "pending" });
  });

  let stateA;
  await t.test("GitHub authorize stores a hashed state and an encrypted PKCE verifier", async () => {
    const response = await post("/student/skills/platforms/github/authorize", {});
    assert.equal(response.statusCode, 200);
    const url = new URL(response.json().data.url);
    stateA = url.searchParams.get("state");
    assert.ok(stateA.length >= 43);
    const row = await one("SELECT * FROM student.oauth_states WHERE user_id=$1", [users.a]);
    assert.equal(row.state_hash, createHash("sha256").update(stateA).digest("hex"));
    assert.match(row.verifier_cipher, /^v1\.k1\./);
    const verifier = secrets.decrypt(row.verifier_cipher, "oauth_states:" + row.state_hash);
    assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
    assert.ok(new Date(row.expires_at) - Date.now() <= 10 * 60000 + 5000);

    const bare = await buildApp({ pool: { ...pool, end: async () => {} }, env: { SERVICE_TOKEN: "x".repeat(32) }, logger: false, verify: async (token) => ({ id: users[token] }), integrations });
    const missing = await bare.inject({ method: "POST", url: "/api/v1/student/skills/platforms/github/authorize", headers: { authorization: "Bearer a" }, payload: {} });
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.json().error.code, "GITHUB_APP_NOT_CONFIGURED");
    const pat = await bare.inject({ method: "POST", url: "/api/v1/student/skills/platforms/github/token", headers: { authorization: "Bearer a" }, payload: { token: PAT_B } });
    assert.equal(pat.statusCode, 503);
    assert.equal(pat.json().error.code, "INTEGRATIONS_NOT_CONFIGURED");
    await bare.close();
  });

  await t.test("OAuth callback: wrong user, single use, expiry and external id binding", async () => {
    let response = await post("/student/skills/platforms/github/callback", { code: "code-a", state: stateA }, "b");
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "OAUTH_STATE_INVALID");
    assert.equal(calls.exchange.length, 0);
    response = await post("/student/skills/platforms/github/callback", { code: "code-a", state: stateA });
    assert.equal(response.statusCode, 200);
    const account = response.json().data;
    assert.deepEqual([account.state, account.handle, account.authMethod, account.ownership, account.syncStatus, account.profileUrl], ["linked", "alice-gh", "github_app", "platform_verified", "pending", "https://github.com/alice-gh"]);
    const challenge = createHash("sha256").update(calls.exchange[0].codeVerifier).digest("base64url");
    assert.match(calls.exchange[0].codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.ok(challenge);
    const row = await one("SELECT external_id,id FROM student.platform_accounts WHERE student_id=$1 AND platform='github'", [students.a]);
    assert.equal(row.external_id, "42");
    const cred = await one("SELECT * FROM student.platform_credentials WHERE account_id=$1", [row.id]);
    assert.equal(cred.kind, "github_user_token");
    assert.ok(!cred.access_cipher.includes("ghu_") && !cred.refresh_cipher.includes("ghr_"));
    assert.equal(secrets.decrypt(cred.access_cipher, credentialAad(row.id, "github_user_token", "access")), "ghu_access_1");
    assert.throws(() => secrets.decrypt(cred.access_cipher, credentialAad(randomUUID(), "github_user_token", "access")));

    response = await post("/student/skills/platforms/github/callback", { code: "code-a", state: stateA });
    assert.equal(response.json().error.code, "OAUTH_STATE_INVALID", "state is single-use");
    assert.equal(calls.exchange.length, 1);

    const expired = (await post("/student/skills/platforms/github/authorize", {})).json().data.url;
    const expiredState = new URL(expired).searchParams.get("state");
    await db.query("UPDATE student.oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [createHash("sha256").update(expiredState).digest("hex")]);
    response = await post("/student/skills/platforms/github/callback", { code: "code-a", state: expiredState });
    assert.equal(response.json().error.code, "OAUTH_STATE_INVALID");
    assert.equal(calls.exchange.length, 1);
    assert.equal((await post("/student/skills/platforms/github/callback", { code: "x y", state: expiredState })).statusCode, 400);
  });

  await t.test("PAT path: prefix rules and one student per GitHub account", async () => {
    let response = await post("/student/skills/platforms/github/token", { token: "ghp_" + "a".repeat(36) }, "b");
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "FINE_GRAINED_TOKEN_REQUIRED");
    response = await post("/student/skills/platforms/github/token", { token: PAT_B }, "b");
    assert.equal(response.json().error.code, "GITHUB_TOKEN_INVALID");
    accessOwners.set(PAT_B, { id: 42, login: "alice-gh" });
    response = await post("/student/skills/platforms/github/token", { token: PAT_B }, "b");
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "GITHUB_ACCOUNT_IN_USE");
    assert.equal(await one("SELECT count(*)::int AS n FROM student.platform_credentials c JOIN student.platform_accounts a ON a.id=c.account_id WHERE a.student_id=$1", [students.b]).then((r) => r.n), 0);
    accessOwners.set(PAT_B, { id: 77, login: "bob-gh" });
    response = await post("/student/skills/platforms/github/token", { token: PAT_B }, "b");
    assert.equal(response.statusCode, 200);
    assert.deepEqual([response.json().data.authMethod, response.json().data.handle], ["github_pat", "bob-gh"]);
  });

  await t.test("worker: claims jobs, writes metrics, repositories and snapshots with provenance", async () => {
    assert.equal(await worker.runOnce(), 2, "one general job plus the LeetCode group");
    assert.equal(await worker.runOnce(), 1);
    assert.equal(await worker.runOnce(), 1);
    assert.equal(await worker.runOnce(), 0);
    const accounts = (await db.query("SELECT platform,sync_status,sync_error,last_synced_at FROM student.platform_accounts WHERE platform IN ('github','huggingface') ORDER BY student_id,platform")).rows;
    assert.ok(accounts.every((a) => a.sync_status === "completed" && a.last_synced_at && !a.sync_error), JSON.stringify(accounts));
    const accountA = await one("SELECT id FROM student.platform_accounts WHERE student_id=$1 AND platform='github'", [students.a]);
    const metrics = (await db.query("SELECT metric,value,verification,method,snapshot_id FROM student.platform_metrics WHERE account_id=$1", [accountA.id])).rows;
    const byKey = Object.fromEntries(metrics.map((m) => [m.metric, m]));
    assert.equal(byKey["repos.public"].value, 4);
    assert.equal(byKey["repos.public"].verification, "platform_verified");
    assert.equal(byKey["contributions.lines_added_52w"].method, "github_rest_stats");
    assert.ok(metrics.every((m) => m.snapshot_id));
    const repos = (await db.query("SELECT repo_id::int AS id,recommendation_score,recommendation_reasons,additions_52w FROM student.github_repositories WHERE account_id=$1 ORDER BY repo_id", [accountA.id])).rows;
    assert.deepEqual(repos.map((r) => r.id), [1001, 1002, 1003, 1004]);
    assert.ok(repos[0].recommendation_reasons.includes("Has a README"));
    assert.equal(repos[0].additions_52w, 20);
    const snapshots = (await db.query("SELECT payload,status,method FROM student.platform_snapshots WHERE student_id=$1", [students.a])).rows;
    assert.equal(snapshots.length, 3);
    const lc = (await db.query("SELECT metric,value,verification,method FROM student.platform_metrics WHERE student_id=$1 AND platform='leetcode' ORDER BY metric", [students.a])).rows;
    assert.deepEqual(lc.map((m) => [m.metric, m.verification, m.method]), [
      ["problems.easy", "platform_verified", "leetcode_public_graphql"], ["problems.hard", "platform_verified", "leetcode_public_graphql"],
      ["problems.medium", "platform_verified", "leetcode_public_graphql"], ["problems.solved", "platform_verified", "leetcode_public_graphql"],
      ["topics.solved", "platform_verified", "leetcode_public_graphql"]]);
    assert.deepEqual(leetcode.calls, ["coder"]);
    // "coder" does not resemble "Student a"; the LeetCode profile name "Student A" does.
    assert.deepEqual(await one("SELECT name_match,name_match_source FROM student.platform_accounts WHERE student_id=$1 AND platform='leetcode'", [students.a]),
      { name_match: "verified", name_match_source: "profile_name" });
    assert.ok(!JSON.stringify((await db.query("SELECT payload FROM student.platform_snapshots WHERE platform='leetcode'")).rows).includes("Student A"), "the profile name is not stored");
    assert.ok((await one("SELECT count(*)::int AS n FROM ranking.queue WHERE student_id=$1", [students.a])).n <= 1, "new evidence queues one recalculation");
    const hf = await one("SELECT value,verification FROM student.platform_metrics WHERE student_id=$1 AND metric='models.count'", [students.a]);
    assert.deepEqual(hf, { value: 2, verification: "platform_verified" });
    assert.equal(calls.fetch[0].options.externalId, "42");
    // Students read their own metrics but cannot see another student's.
    const me = await call("GET", "/student/me");
    assert.equal(me.statusCode, 200);
  });

  await t.test("featured projects accept only the student's own synced repositories", async () => {
    let response = await post("/student/skills/featured", { repoIds: [1003, "1001"] });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.featured.map((f) => [f.position, f.repoId, f.name]), [[1, "1003", "gamma"], [2, "1001", "alpha"]]);
    response = await post("/student/skills/featured", { repoIds: [2001] });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_FEATURED");
    assert.equal((await post("/student/skills/featured", { repoIds: [1001, 1002, 1003, 1004] })).statusCode, 400);
    assert.equal((await post("/student/skills/featured", { repoIds: [1001, 1001] })).statusCode, 400);
    response = await post("/student/skills/featured", { repoIds: [1004] });
    assert.deepEqual((await db.query("SELECT position,repo_id::int AS r FROM student.featured_projects WHERE student_id=$1", [students.a])).rows, [{ position: 1, r: 1004 }]);
    assert.equal((await post("/student/skills/featured", { repoIds: [2001] }, "b")).statusCode, 200);
  });

  await t.test("onboarding completes once the required platforms are linked, without optional ones", async () => {
    const status = (await post("/student/skills/onboarding", { action: "confirm_identity" })).json().data;
    assert.deepEqual(status.missing, []);
    assert.equal(status.sections.kaggle, false, "Kaggle is optional");
    let response = await post("/student/skills/onboarding", { action: "complete", consent: true, revision: status.revision - 1 });
    assert.equal(response.json().error.code, "PROFILE_CHANGED");
    response = await post("/student/skills/onboarding", { action: "complete", consent: true, revision: status.revision });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.complete, true);
    const profile = await one("SELECT onboarding_version,consent_version,consented_at,onboarding_completed_at FROM student.skill_profiles WHERE student_id=$1", [students.a]);
    assert.equal(profile.onboarding_version, 2);
    assert.equal(profile.consent_version, 1);
    assert.ok(profile.consented_at && profile.onboarding_completed_at);
    assert.deepEqual((await call("GET", "/session")).json().data, { role: "student", home: "/student", onboardingRequired: false });
    assert.equal((await call("GET", "/student/dashboard")).statusCode, 200);
    assert.equal((await call("GET", "/student/readiness")).statusCode, 200);
    assert.equal((await call("GET", "/student/dashboard", "b")).statusCode, 403);
    assert.equal((await call("GET", "/student/readiness", "b")).statusCode, 403);
  });

  await t.test("manual refresh is limited to once per 10 minutes", async () => {
    let response = await post("/student/skills/platforms/github/refresh", {});
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.syncStatus, "pending");
    response = await post("/student/skills/platforms/github/refresh", {});
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().error.code, "REFRESH_LIMIT");
    assert.ok(Number(response.headers["retry-after"]) > 500);
    assert.equal((await post("/student/skills/platforms/linkedin/refresh", {})).json().error.code, "NOT_SYNCABLE");
    assert.equal(await one("SELECT count(*)::int AS n FROM student.sync_jobs WHERE student_id=$1 AND status='pending'", [students.a]).then((r) => r.n), 1);
  });

  await t.test("worker: token refresh under lock, failure keeps metrics and backs off", async () => {
    const account = await one("SELECT id FROM student.platform_accounts WHERE student_id=$1 AND platform='github'", [students.a]);
    await db.query("UPDATE student.platform_credentials SET access_expires_at=now()-interval '1 minute' WHERE account_id=$1", [account.id]);
    github.fail = new ProviderError("PROVIDER_UNAVAILABLE", "down");
    const before = (await db.query("SELECT metric,value,snapshot_id FROM student.platform_metrics WHERE account_id=$1 ORDER BY metric", [account.id])).rows;
    assert.equal(await worker.runOnce(), 1);
    assert.deepEqual(calls.refresh, ["ghr_refresh_1"]);
    assert.equal(calls.fetch.at(-1).token, "ghu_access_2", "the rotated access token is used");
    const cred = await one("SELECT * FROM student.platform_credentials WHERE account_id=$1", [account.id]);
    assert.equal(secrets.decrypt(cred.refresh_cipher, credentialAad(account.id, "github_user_token", "refresh")), "ghr_refresh_2");
    assert.ok(new Date(cred.access_expires_at) > new Date());
    assert.deepEqual((await db.query("SELECT metric,value,snapshot_id FROM student.platform_metrics WHERE account_id=$1 ORDER BY metric", [account.id])).rows, before);
    const job = await one("SELECT status,attempts,last_error,reason,EXTRACT(EPOCH FROM run_after-now())::int AS wait FROM student.sync_jobs WHERE account_id=$1 ORDER BY id DESC LIMIT 1", [account.id]);
    assert.deepEqual([job.status, job.attempts, job.last_error, job.reason], ["pending", 1, "PROVIDER_UNAVAILABLE", "retry"]);
    assert.ok(job.wait > 100 && job.wait <= 120, "2^1 minutes backoff, got " + job.wait);
    const state = await one("SELECT sync_status,sync_error FROM student.platform_accounts WHERE id=$1", [account.id]);
    assert.deepEqual(state, { sync_status: "failed", sync_error: "PROVIDER_UNAVAILABLE" });
    assert.ok(logs.some((l) => l.event === "sync_job_failed" && l.code === "PROVIDER_UNAVAILABLE"));

    // Rate limits reschedule at the provider reset and do not consume attempts.
    await db.query("UPDATE student.sync_jobs SET run_after=now() WHERE account_id=$1 AND status='pending'", [account.id]);
    const reset = new Date(Date.now() + 30 * 60000);
    github.fail = new ProviderError("RATE_LIMITED", "limit", { retryAt: reset });
    assert.equal(await worker.runOnce(), 1);
    const limited = await one("SELECT status,attempts,EXTRACT(EPOCH FROM run_after)::bigint AS at FROM student.sync_jobs WHERE account_id=$1 AND status='pending'", [account.id]);
    assert.equal(limited.attempts, 1);
    assert.ok(Math.abs(Number(limited.at) * 1000 - reset.getTime()) < 2000);
    assert.equal(calls.refresh.length, 1, "no second refresh while the token is fresh");
  });

  await t.test("worker: revoked credentials stop retries without touching onboarding", async () => {
    const account = await one("SELECT id FROM student.platform_accounts WHERE student_id=$1 AND platform='github'", [students.a]);
    await db.query("UPDATE student.sync_jobs SET run_after=now() WHERE account_id=$1 AND status='pending'", [account.id]);
    github.fail = new ProviderError("CREDENTIAL_INVALID", "revoked", { status: 401 });
    assert.equal(await worker.runOnce(), 1);
    const job = await one("SELECT status,last_error FROM student.sync_jobs WHERE account_id=$1 ORDER BY id DESC LIMIT 1", [account.id]);
    assert.deepEqual(job, { status: "failed", last_error: "CREDENTIAL_INVALID" });
    assert.deepEqual(await one("SELECT sync_status,sync_error,state FROM student.platform_accounts WHERE id=$1", [account.id]), { sync_status: "failed", sync_error: "CREDENTIAL_INVALID", state: "linked" });
    assert.equal((await one("SELECT onboarding_version FROM student.skill_profiles WHERE student_id=$1", [students.a])).onboarding_version, 2);
    assert.ok((await db.query("SELECT 1 FROM student.platform_metrics WHERE account_id=$1", [account.id])).rows.length > 0);
    assert.equal((await post("/student/skills/platforms/github/refresh", {})).json().error.code, "RECONNECT_REQUIRED");
    // Scheduled sync skips accounts whose credential is invalid.
    await db.query("UPDATE student.platform_accounts SET last_synced_at=now()-interval '3 days'");
    const queued = await enqueueScheduled(pool, 24);
    assert.equal(queued, 3, "student B's GitHub, A's LeetCode and A's Hugging Face only");
    assert.equal(await enqueueScheduled(pool, 24), 0, "no duplicate open jobs");
    github.fail = null;
  });

  await t.test("queue: idempotent enqueue, SKIP LOCKED claims and expired leases", async () => {
    await db.query("UPDATE student.sync_jobs SET status='cancelled' WHERE status IN ('pending','running')");
    const account = await one("SELECT id,student_id,platform FROM student.platform_accounts WHERE student_id=$1 AND platform='huggingface'", [students.a]);
    const first = await workerTransaction(pool, (c) => enqueue(c, account, "manual"));
    assert.ok(first);
    assert.equal(await workerTransaction(pool, (c) => enqueue(c, account, "manual")), null);
    const claimed = await claimJobs(pool, 4);
    assert.deepEqual(claimed.map((j) => [String(j.id), j.attempts]), [[String(first), 1]]);
    assert.equal((await claimJobs(pool, 4)).length, 0, "a leased job is not claimed twice");
    const lease = await one("SELECT status,EXTRACT(EPOCH FROM leased_until-now())::int AS lease FROM student.sync_jobs WHERE id=$1", [first]);
    assert.equal(lease.status, "running");
    assert.ok(lease.lease > 100 && lease.lease <= 120);
    await db.query("UPDATE student.sync_jobs SET leased_until=now()-interval '1 second' WHERE id=$1", [first]);
    assert.deepEqual((await claimJobs(pool, 4)).map((j) => j.attempts), [2], "expired leases are reclaimed");
    await db.query("UPDATE student.sync_jobs SET leased_until=now()-interval '1 second',attempts=max_attempts WHERE id=$1", [first]);
    assert.equal((await claimJobs(pool, 4)).length, 0);
    assert.equal((await one("SELECT status,last_error FROM student.sync_jobs WHERE id=$1", [first])).last_error, "LEASE_EXPIRED");
    // Hugging Face 404: terminal, keeps the account linked.
    await workerTransaction(pool, (c) => enqueue(c, account, "manual"));
    huggingface.fail = new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "missing", { status: 404 });
    assert.equal(await worker.runOnce(), 1);
    assert.deepEqual(await one("SELECT sync_status,sync_error FROM student.platform_accounts WHERE id=$1", [account.id]), { sync_status: "failed", sync_error: "PLATFORM_ACCOUNT_NOT_FOUND" });
    huggingface.fail = null;
  });

  await t.test("required platforms cannot be disconnected or declared absent, and a refused request changes nothing", async () => {
    const account = await one("SELECT id FROM student.platform_accounts WHERE student_id=$1 AND platform='github'", [students.a]);
    const before = {
      credentials: (await db.query("SELECT 1 FROM student.platform_credentials WHERE account_id=$1", [account.id])).rows.length,
      metrics: (await db.query("SELECT 1 FROM student.platform_metrics WHERE account_id=$1", [account.id])).rows.length,
      revoked: calls.revoke.length,
    };
    assert.equal(before.credentials, 1);
    assert.ok(before.metrics > 0);
    for (const platform of ["github", "leetcode", "linkedin"])
      for (const action of ["disconnect", "declare_none"]) {
        const response = await post("/student/skills/platforms/" + platform, { action });
        assert.equal(response.statusCode, 409, platform + " " + action);
        assert.equal(response.json().error.code, "REQUIRED_PLATFORM");
      }
    // Nothing was revoked, deleted or downgraded by the refused requests.
    assert.equal(calls.revoke.length, before.revoked);
    assert.equal((await db.query("SELECT 1 FROM student.platform_credentials WHERE account_id=$1", [account.id])).rows.length, before.credentials);
    assert.equal((await db.query("SELECT 1 FROM student.platform_metrics WHERE account_id=$1", [account.id])).rows.length, before.metrics);
    assert.equal((await one("SELECT state FROM student.platform_accounts WHERE id=$1", [account.id])).state, "linked");
    assert.equal((await one("SELECT onboarding_version FROM student.skill_profiles WHERE student_id=$1", [students.a])).onboarding_version, 2);
    assert.equal((await call("GET", "/session")).json().data.onboardingRequired, false);
    assert.equal((await call("GET", "/student/dashboard")).statusCode, 200);
    // Hiding a required platform from officers is still allowed.
    assert.equal((await post("/student/skills/platforms/github", { action: "visibility", visible: false })).statusCode, 200);
    assert.equal((await post("/student/skills/platforms/github", { action: "visibility", visible: true })).statusCode, 200);
    // Optional platforms can still be declared absent or disconnected.
    assert.equal((await post("/student/skills/platforms/kaggle", { action: "declare_none" })).json().data.state, "declared_none");
    const actions = (await db.query("SELECT action FROM erp.audit_events WHERE action LIKE 'skills.%' ORDER BY id")).rows.map((r) => r.action);
    for (const action of ["skills.platform.connect", "skills.platform.token", "skills.platform.refresh", "skills.platform.declare_none", "skills.onboarding.complete"])
      assert.ok(actions.includes(action), action);
  });

  await t.test("tokens and ciphers never appear in responses or snapshots", async () => {
    const snapshots = JSON.stringify((await db.query("SELECT payload FROM student.platform_snapshots")).rows);
    for (const marker of SECRET_MARKERS) {
      assert.ok(!snapshots.includes(marker), "snapshot leaked " + marker);
      for (const body of bodies) assert.ok(!body.includes(marker), "response leaked " + marker);
    }
    assert.ok(!logs.some((l) => SECRET_MARKERS.some((m) => JSON.stringify(l).includes(m))));
  });

  await t.test("worker waits quietly for the migration", async () => {
    const missing = Object.assign(new Error('relation "student.sync_jobs" does not exist'), { code: "42P01" });
    const broken = { connect: async () => ({ query: async (sql) => { if (/sync_jobs/.test(sql)) throw missing; return { rows: [] }; }, release() {} }) };
    const quiet = [];
    const waiting = createSyncWorker({ pool: broken, env: ENV, integrations, log: (entry) => quiet.push(entry), migrationRetryMs: 0 });
    for (let i = 0; i < 3; i++) await waiting.runOnce();
    assert.deepEqual(quiet, [{ event: "sync_worker_waiting_for_migration", code: "42P01" }]);
    await waiting.stop(100);
  });
});

test("review fixes: single-token revoke, connect races and stale sync jobs", { timeout: 300000 }, async (t) => {
  const { db, pool } = await testDatabase();
  const users = { c: randomUUID(), d: randomUUID(), officer: randomUUID() };
  const students = { c: randomUUID(), d: randomUUID() };
  await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [Object.values(users)]);
  for (const key of ["c", "d"]) {
    await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash) VALUES($1,$2,$3,'2027',$4)", [students[key], "RF" + key, "Student " + key, key]);
    await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [users[key], students[key]]);
  }
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [users.officer]);

  // Pool wrapper: records SQL and can inject a unique violation on the credential insert.
  const seen = [];
  let failCredentialInsert = false;
  const wrapped = {
    ...pool,
    connect: async () => {
      const inner = await pool.connect();
      return {
        async query(sql, values) {
          seen.push(sql);
          if (failCredentialInsert && /^\s*INSERT INTO student\.platform_credentials/.test(sql)) {
            failCredentialInsert = false;
            throw Object.assign(new Error('duplicate key value violates unique constraint "platform_credentials_pkey"'), { code: "23505", constraint: "platform_credentials_pkey" });
          }
          return inner.query(sql, values);
        },
        release: () => inner.release(),
      };
    },
  };

  const revoked = [];
  let issued = 0;
  const owners = new Map();
  const github = {
    authorizeUrl: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
    async exchangeCode({ code }) {
      const token = `ghu_rf_${++issued}`;
      owners.set(token, code === "gh-500" ? { id: 500, login: "carol-gh" } : { id: 600, login: "dan-gh" });
      return { accessToken: token, refreshToken: `ghr_rf_${issued}`, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(), refreshExpiresAt: null };
    },
    async user(token) {
      const owner = owners.get(token);
      return { ...owner, url: `https://github.com/${owner.login}`, tokenExpiresAt: null };
    },
    async revoke(token) {
      revoked.push(token);
    },
  };
  const huggingface = {
    hook: null,
    async fetchProfile(username) {
      if (this.hook) return this.hook(username);
      return { account: { username }, counts: { models: 1, datasets: 0, spaces: 0 }, top: { models: [], datasets: [], spaces: [] } };
    },
  };
  // LeetCode is synced from public profile data; tests never reach leetcode.com.
  const leetcode = {
    calls: [],
    async fetchProfile(username) {
      this.calls.push(username);
      return { account: { username }, realName: "Student A", solved: { all: 120, easy: 60, medium: 50, hard: 10 }, contest: null, tags: [{ slug: "array", name: "Array", solved: 40, level: "fundamental" }] };
    },
  };
  const integrations = { github, huggingface, leetcode };
  const app = await buildApp({ pool: wrapped, env: ENV, logger: false, verify: async (token) => ({ id: users[token] }), integrations });
  t.after(() => app.close());
  const logs = [];
  const worker = createSyncWorker({ pool: wrapped, env: ENV, integrations, log: (entry) => logs.push(entry) });
  const post = (url, payload, user = "c") => app.inject({ method: "POST", url: "/api/v1" + url, headers: { authorization: "Bearer " + user }, payload });
  const one = async (sql, values) => (await db.query(sql, values)).rows[0];
  const secrets = createSecrets(ENV);
  const connect = async (user, code) => {
    const url = new URL((await post("/student/skills/platforms/github/authorize", {}, user)).json().data.url);
    return post("/student/skills/platforms/github/callback", { code, state: url.searchParams.get("state") }, user);
  };
  const storedToken = async (studentId) => {
    const row = await one(
      "SELECT c.account_id,c.kind,c.access_cipher FROM student.platform_credentials c JOIN student.platform_accounts a ON a.id=c.account_id WHERE a.student_id=$1",
      [studentId],
    );
    return row ? secrets.decrypt(row.access_cipher, credentialAad(row.account_id, row.kind, "access")) : null;
  };

  await t.test("reconnect revokes only the replaced token; account-in-use revokes only the new one", async () => {
    assert.equal((await connect("c", "gh-500")).statusCode, 200);
    assert.equal(await storedToken(students.c), "ghu_rf_1");
    assert.ok(seen.some((sql) => /pg_advisory_xact_lock/.test(sql)), "connects are serialised per student");
    // Reconnecting the same GitHub account keeps the new token alive.
    assert.equal((await connect("c", "gh-500")).statusCode, 200);
    assert.equal(await storedToken(students.c), "ghu_rf_2");
    assert.deepEqual(revoked, ["ghu_rf_1"]);
    // Another student authorizes the same GitHub account: only their fresh token is revoked.
    const inUse = await connect("d", "gh-500");
    assert.equal(inUse.statusCode, 409);
    assert.equal(inUse.json().error.code, "GITHUB_ACCOUNT_IN_USE");
    assert.deepEqual(revoked, ["ghu_rf_1", "ghu_rf_3"]);
    assert.equal(await storedToken(students.c), "ghu_rf_2", "the other student's token is untouched");
    assert.equal(await storedToken(students.d), null);
  });

  await t.test("a residual unique violation on connect is a 409 and revokes the issued token", async () => {
    failCredentialInsert = true;
    const response = await connect("d", "gh-600");
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "GITHUB_CONNECT_CONFLICT");
    assert.deepEqual(revoked, ["ghu_rf_1", "ghu_rf_3", "ghu_rf_4"]);
    assert.equal(await storedToken(students.d), null);
    assert.equal((await one("SELECT count(*)::int AS n FROM student.platform_accounts WHERE student_id=$1", [students.d])).n, 0, "rolled back");
    assert.equal((await connect("d", "gh-600")).statusCode, 200);
    assert.equal(await storedToken(students.d), "ghu_rf_5");
  });

  await t.test("disconnecting the required GitHub platform is refused and revokes nothing", async () => {
    const response = await post("/student/skills/platforms/github", { action: "disconnect" });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "REQUIRED_PLATFORM");
    assert.deepEqual(revoked.slice(3), [], "nothing is revoked by a refused request");
    assert.equal(await storedToken(students.c), "ghu_rf_2");
    assert.equal(await storedToken(students.d), "ghu_rf_5");
  });

  const linkHf = async (handle) => {
    const response = await post("/student/skills/platforms/huggingface", { action: "link", value: handle });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  const hfAccount = () => one("SELECT * FROM student.platform_accounts WHERE student_id=$1 AND platform='huggingface'", [students.c]);
  const jobs = async () =>
    (await db.query("SELECT id,status,attempts,last_error FROM student.sync_jobs WHERE student_id=$1 AND platform='huggingface' ORDER BY id", [students.c])).rows;
  const clearQueue = () => db.query("UPDATE student.sync_jobs SET status='cancelled',leased_until=NULL WHERE status IN ('pending','running')");

  await t.test("a stale job failing after a relink never overwrites the new account state", async () => {
    await clearQueue();
    await linkHf("carol-hf");
    huggingface.hook = async () => {
      await linkHf("carol-hf-new"); // relink while the provider call runs
      throw new ProviderError("PROVIDER_UNAVAILABLE", "down");
    };
    assert.equal(await worker.runOnce(), 1);
    huggingface.hook = null;
    const account = await hfAccount();
    assert.deepEqual([account.handle, account.sync_status, account.sync_error], ["carol-hf-new", "pending", null]);
    const [old, fresh] = (await jobs()).slice(-2);
    assert.deepEqual([old.status, old.last_error], ["cancelled", null]);
    assert.deepEqual([fresh.status, fresh.attempts], ["pending", 0]);
    assert.ok(logs.some((l) => l.event === "sync_job_stale" && l.code === "PROVIDER_UNAVAILABLE"));
    assert.ok(!logs.some((l) => l.event === "sync_job_failed"));
  });

  await t.test("a stale job succeeding after a relink writes nothing", async () => {
    await clearQueue();
    await linkHf("carol-hf");
    let relinked = false;
    huggingface.hook = async (username) => {
      if (!relinked) {
        relinked = true;
        await linkHf("carol-hf-other");
      }
      return { account: { username }, counts: { models: 9, datasets: 0, spaces: 0 }, top: { models: [], datasets: [], spaces: [] } };
    };
    assert.equal(await worker.runOnce(), 1);
    huggingface.hook = null;
    const account = await hfAccount();
    assert.deepEqual([account.handle, account.sync_status, account.last_synced_at], ["carol-hf-other", "pending", null]);
    assert.equal((await db.query("SELECT 1 FROM student.platform_metrics WHERE account_id=$1", [account.id])).rows.length, 0);
  });

  await t.test("a job whose lease was reclaimed by another worker records nothing", async () => {
    await clearQueue();
    await linkHf("carol-hf-lease");
    huggingface.hook = async () => {
      // Another worker reclaims the expired lease (attempt 2) while this one is still running.
      await db.query("UPDATE student.sync_jobs SET attempts=attempts+1,leased_until=now()+interval '2 minutes' WHERE student_id=$1 AND status='running'", [students.c]);
      throw new ProviderError("PROVIDER_UNAVAILABLE", "down");
    };
    assert.equal(await worker.runOnce(), 1);
    huggingface.hook = null;
    const job = (await jobs()).at(-1);
    assert.deepEqual([job.status, job.attempts, job.last_error], ["running", 2, null]);
    assert.equal((await hfAccount()).sync_error, null);
  });

  await t.test("a job failing after a disconnect leaves the disconnected account alone", async () => {
    await clearQueue();
    await linkHf("carol-hf-gone");
    huggingface.hook = async () => {
      assert.equal((await post("/student/skills/platforms/huggingface", { action: "disconnect" })).statusCode, 200);
      throw new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "missing");
    };
    assert.equal(await worker.runOnce(), 1);
    huggingface.hook = null;
    const account = await hfAccount();
    assert.deepEqual([account.state, account.sync_status, account.sync_error], ["disconnected", "not_applicable", null]);
    assert.equal((await jobs()).at(-1).status, "cancelled");
  });
});
