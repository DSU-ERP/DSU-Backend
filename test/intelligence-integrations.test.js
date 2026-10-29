import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSecrets, parseKeys } from "../src/platform/crypto/secrets.js";
import { readEnv } from "../src/config/env.js";
import { normalizePlatformValue, validateSubmitted, ProviderError } from "../src/modules/intelligence/platforms.js";
import {
  assertFineGrainedToken,
  classifyGitHubError,
  contributionStreaks,
  createGitHub,
  languageShare,
  parseTokenExpiry,
  scoreRepository,
  sumAdditions,
} from "../src/modules/intelligence/github.js";
import { createHuggingFace, rateLimitDelay } from "../src/modules/intelligence/huggingface.js";
import { githubResult, huggingFaceResult } from "../src/modules/intelligence/sync.js";
import { parseDatabaseUrl, provisionInTransaction, staticChecks } from "../src/platform/devguard.js";

const key = () => randomBytes(32).toString("base64");
const keyA = key(), keyB = key();

test("secrets: AES-256-GCM round trip, AAD binding, unknown kid and rotation", () => {
  const old = createSecrets({ INTEGRATION_ENCRYPTION_KEYS: `k1:${keyA}`, INTEGRATION_ENCRYPTION_KEY_ID: "k1" });
  const cipher = old.encrypt("ghu_secret_value", "acct:1|github_user_token|access");
  assert.match(cipher, /^v1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
  assert.ok(!cipher.includes("ghu_secret_value"));
  assert.notEqual(cipher, old.encrypt("ghu_secret_value", "acct:1|github_user_token|access"), "random IV");
  assert.equal(old.decrypt(cipher, "acct:1|github_user_token|access"), "ghu_secret_value");
  assert.throws(() => old.decrypt(cipher, "acct:2|github_user_token|access"), (e) => e.code === "SECRET_UNREADABLE" && !e.message.includes("ghu_"));
  const tampered = cipher.slice(0, -2) + (cipher.endsWith("A") ? "BB" : "AA");
  assert.throws(() => old.decrypt(tampered, "acct:1|github_user_token|access"));
  assert.throws(() => old.decrypt("v1.k9.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA", "x"), (e) => e.code === "SECRET_KEY_UNKNOWN");
  assert.throws(() => old.decrypt("garbage", "x"));

  // Rotation: new current key, old key still decrypts, needsRotation flags old ciphers.
  const rotated = createSecrets({ INTEGRATION_ENCRYPTION_KEYS: `k1:${keyA},k2:${keyB}`, INTEGRATION_ENCRYPTION_KEY_ID: "k2" });
  assert.equal(rotated.decrypt(cipher, "acct:1|github_user_token|access"), "ghu_secret_value");
  assert.equal(rotated.needsRotation(cipher), true);
  const fresh = rotated.encrypt("x", "a");
  assert.equal(rotated.needsRotation(fresh), false);
  assert.equal(rotated.keyIdOf(fresh), "k2");
  assert.throws(() => old.decrypt(fresh, "a"), (e) => e.code === "SECRET_KEY_UNKNOWN");

  const missing = createSecrets({});
  assert.equal(missing.configured, false);
  assert.throws(() => missing.encrypt("x", "a"), (e) => e.code === "INTEGRATIONS_NOT_CONFIGURED" && e.statusCode === 503);
  assert.throws(() => parseKeys("k1:" + Buffer.alloc(16).toString("base64")), /32 bytes/);
  assert.throws(() => parseKeys("k1:" + keyA + ",k1:" + keyB));
  assert.throws(() => parseKeys("bad.kid:" + keyA));
  assert.equal(createSecrets({ INTEGRATION_ENCRYPTION_KEYS: `k1:${keyA}`, INTEGRATION_ENCRYPTION_KEY_ID: "k2" }).configured, false);
});

test("env: integration keys, worker settings and redirect URL", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost/db",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "pk",
    SERVICE_TOKEN: "s".repeat(32),
  };
  const env = readEnv(base);
  assert.equal(env.SYNC_WORKER, "on");
  assert.equal(env.SYNC_WORKER_CONCURRENCY, 2);
  assert.equal(env.SYNC_INTERVAL_HOURS, 24);
  assert.equal(readEnv({ ...base, INTEGRATION_ENCRYPTION_KEYS: `k1:${keyA}`, INTEGRATION_ENCRYPTION_KEY_ID: "k1" }).INTEGRATION_ENCRYPTION_KEY_ID, "k1");
  assert.throws(() => readEnv({ ...base, INTEGRATION_ENCRYPTION_KEYS: `k1:${keyA}` }), /INTEGRATION_ENCRYPTION_KEY_ID/);
  assert.throws(() => readEnv({ ...base, INTEGRATION_ENCRYPTION_KEY_ID: "k1" }), /INTEGRATION_ENCRYPTION_KEYS/);
  assert.throws(() => readEnv({ ...base, INTEGRATION_ENCRYPTION_KEYS: `k1:${keyA}`, INTEGRATION_ENCRYPTION_KEY_ID: "k2" }), /INTEGRATION_ENCRYPTION_KEYS/);
  assert.throws(() => readEnv({ ...base, INTEGRATION_ENCRYPTION_KEYS: "k1:c2hvcnQ=", INTEGRATION_ENCRYPTION_KEY_ID: "k1" }), /INTEGRATION_ENCRYPTION_KEYS/);
  try {
    readEnv({ ...base, INTEGRATION_ENCRYPTION_KEYS: `k1:${keyA}`, INTEGRATION_ENCRYPTION_KEY_ID: "k2" });
  } catch (error) {
    assert.ok(!error.message.includes(keyA), "key material never appears in errors");
  }
  assert.throws(() => readEnv({ ...base, SYNC_WORKER_CONCURRENCY: "5" }), /SYNC_WORKER_CONCURRENCY/);
  assert.throws(() => readEnv({ ...base, SYNC_INTERVAL_HOURS: "0" }), /SYNC_INTERVAL_HOURS/);
  assert.throws(() => readEnv({ ...base, SYNC_WORKER: "maybe" }), /SYNC_WORKER/);
  const prod = { ...base, NODE_ENV: "production", ASSESSMENT_CODE_SECRET: "c".repeat(32), RATE_LIMIT_MODE: "redis", REDIS_URL: "redis://localhost:6379" };
  assert.throws(() => readEnv({ ...prod, GITHUB_OAUTH_REDIRECT_URL: "http://localhost:3000/cb" }), /GITHUB_OAUTH_REDIRECT_URL/);
  assert.equal(readEnv({ ...prod, GITHUB_OAUTH_REDIRECT_URL: "https://dsu.example/student/connections/github/callback" }).NODE_ENV, "production");
  assert.equal(readEnv({ ...base, GITHUB_OAUTH_REDIRECT_URL: "http://localhost:3000/student/connections/github/callback" }).NODE_ENV, "development");
});

test("platform values: accepted forms are rebuilt from the handle", () => {
  const accept = [
    ["github", "octocat", "octocat", "https://github.com/octocat"],
    ["github", "https://github.com/Octo-Cat", "Octo-Cat", "https://github.com/Octo-Cat"],
    ["github", "https://GitHub.com/octocat/", "octocat", "https://github.com/octocat"],
    ["leetcode", "https://leetcode.com/u/coder_1/", "coder_1", "https://leetcode.com/u/coder_1/"],
    ["leetcode", "https://leetcode.com/coder-2", "coder-2", "https://leetcode.com/u/coder-2/"],
    ["leetcode", "coder", "coder", "https://leetcode.com/u/coder/"],
    ["hackerrank", "https://www.hackerrank.com/profile/hr_user", "hr_user", "https://www.hackerrank.com/profile/hr_user"],
    ["hackerrank", "https://hackerrank.com/hr_user", "hr_user", "https://www.hackerrank.com/profile/hr_user"],
    ["linkedin", "https://www.linkedin.com/in/jane-doe-123/", "jane-doe-123", "https://www.linkedin.com/in/jane-doe-123"],
    ["linkedin", "https://in.linkedin.com/in/jane-doe", "jane-doe", "https://www.linkedin.com/in/jane-doe"],
    ["linkedin", "https://linkedin.com/in/jane-doe", "jane-doe", "https://www.linkedin.com/in/jane-doe"],
    ["linkedin", "jane-doe", "jane-doe", "https://www.linkedin.com/in/jane-doe"],
    ["huggingface", "https://huggingface.co/some-user", "some-user", "https://huggingface.co/some-user"],
    ["huggingface", "user.name", "user.name", "https://huggingface.co/user.name"],
    ["kaggle", "https://www.kaggle.com/kaggler", "kaggler", "https://www.kaggle.com/kaggler"],
    ["kaggle", "https://kaggle.com/kaggler", "kaggler", "https://www.kaggle.com/kaggler"],
  ];
  for (const [platform, input, handle, profileUrl] of accept)
    assert.deepEqual(normalizePlatformValue(platform, input), { handle, profileUrl }, `${platform} ${input}`);
});

test("platform values: SSRF-ish, lookalike and reserved inputs are rejected", () => {
  const reject = [
    ["github", "https://github.com.evil.com/x"],
    ["github", "https://user:pw@github.com/x"],
    ["github", "https://github.com@evil.com/x"],
    ["github", "http://github.com/octocat"],
    ["github", "javascript:alert(1)"],
    ["github", "//github.com/octocat"],
    ["github", "github.com:8080"],
    ["github", "github.com/octocat"],
    ["github", "https://github.com:8080/octocat"],
    ["github", "https://github.com:443/octocat"],
    ["github", "https://github.com./octocat"],
    ["github", "https://github.com/octocat?tab=repositories"],
    ["github", "https://github.com/octocat#x"],
    ["github", "https://github.com/octocat/repo"],
    ["github", "https://github.com/settings"],
    ["github", "https://github.com/%6Fctocat"],
    ["github", "https://github.com\\@evil.com/x"],
    ["github", "https://gіthub.com/octocat"], // Cyrillic i
    ["github", "oсtocat"], // Cyrillic s
    ["github", "-octocat"],
    ["github", "octo--cat"],
    ["github", "a".repeat(40)],
    ["github", ""],
    ["github", "https://xn--gthub-n4a.com/octocat"],
    ["leetcode", "https://leetcode.com/problems/two-sum"],
    ["leetcode", "https://leetcode.com/u/"],
    ["leetcode", "https://leetcode.cn/u/coder"],
    ["hackerrank", "https://www.hackerrank.com/certificates/abc"],
    ["hackerrank", "https://hackerrank.com/dashboard"],
    ["linkedin", "https://www.linkedin.com/company/acme"],
    ["linkedin", "https://evil.linkedin.com.evil.org/in/x"],
    ["linkedin", "https://abc.linkedin.com/in/jane-doe"],
    ["linkedin", "https://www.linkedin.com/in/jane%20doe"],
    ["huggingface", "https://huggingface.co/models"],
    ["huggingface", "https://huggingface.co/user/model"],
    ["huggingface", "https://hf.co/user"],
    ["kaggle", "https://www.kaggle.com/competitions"],
    ["kaggle", "https://www.kaggle.com/datasets"],
    ["kaggle", "https://www.kaggle.com/code"],
    ["kaggle", "https://www.kaggle.com/models"],
    ["kaggle", "https://www.kaggle.com/discussions"],
    ["kaggle", "https://www.kaggle.com/learn"],
    ["kaggle", "https://www.kaggle.com/settings"],
    ["unknown", "x"],
  ];
  for (const [platform, input] of reject) assert.equal(normalizePlatformValue(platform, input), null, `${platform} ${input}`);
  assert.equal(normalizePlatformValue("github", 42), null);
});

test("student-submitted figures are validated strictly", () => {
  assert.ok(validateSubmitted("leetcode", { solved: 300, easy: 100, medium: 150, hard: 50, contestRating: 1650.5, contestsAttended: 12 }).ok);
  assert.ok(validateSubmitted("leetcode", { solved: 10 }).ok);
  assert.ok(validateSubmitted("leetcode", { easy: 900, medium: 1 }).ok, "sum rule applies only when all four are given");
  assert.equal(validateSubmitted("leetcode", { solved: 10, easy: 5, medium: 5, hard: 1 }).ok, false);
  assert.equal(validateSubmitted("leetcode", { solved: -1 }).ok, false);
  assert.equal(validateSubmitted("leetcode", { solved: 1.5 }).ok, false);
  assert.equal(validateSubmitted("leetcode", { solved: 99999 }).ok, false);
  assert.equal(validateSubmitted("leetcode", { rank: 1 }).ok, false);
  assert.ok(validateSubmitted("hackerrank", {
    badges: [{ name: "Problem Solving", stars: 5 }],
    certifications: [{ name: "SQL (Basic)", url: "https://www.hackerrank.com/certificates/abc123def" }],
  }).ok);
  assert.equal(validateSubmitted("hackerrank", { badges: [{ name: "X", stars: 7 }] }).ok, false);
  assert.equal(validateSubmitted("hackerrank", { badges: Array.from({ length: 21 }, () => ({ name: "X", stars: 1 })) }).ok, false);
  for (const url of [
    "https://hackerrank.com/certificates/abc123def",
    "http://www.hackerrank.com/certificates/abc123def",
    "https://www.hackerrank.com/certificates/abc-123",
    "https://www.hackerrank.com/certificates/abc123def?x=1",
    "https://evil.com/https://www.hackerrank.com/certificates/abc123",
  ])
    assert.equal(validateSubmitted("hackerrank", { certifications: [{ name: "SQL", url }] }).ok, false, url);
  assert.ok(validateSubmitted("kaggle", { achievements: [{ title: "Notebooks Expert" }] }).ok);
  assert.equal(validateSubmitted("kaggle", { achievements: Array.from({ length: 11 }, () => ({ title: "X" })) }).ok, false);
  assert.equal(validateSubmitted("kaggle", { achievements: [{ title: "<script>" }] }).ok, false);
  assert.ok(validateSubmitted("linkedin", {}).ok);
  assert.equal(validateSubmitted("linkedin", { connections: 500 }).ok, false);
  assert.equal(validateSubmitted("huggingface", { models: 3 }).ok, false);
});

// ---- GitHub via the real Octokit code path with an injected fetch -----------------
function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url: String(url), method: init.method || "GET", headers, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect };
    calls.push(call);
    const result = await handler(call);
    const status = result.status ?? 200;
    const body = status === 204 ? null : typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? {});
    return new Response(body, { status, headers: { "content-type": "application/json", date: new Date().toUTCString(), ...(result.headers || {}) } });
  };
  return { fetch, calls };
}
const app = (handler) => {
  const fake = fakeFetch(handler);
  return { ...fake, gh: createGitHub({ clientId: "Iv1.client", clientSecret: "app-secret", redirectUrl: "http://localhost:3000/cb", fetch: fake.fetch }) };
};

test("github: PAT prefix rules and GET /user verification", async () => {
  for (const token of ["ghp_" + "a".repeat(36), "gho_" + "a".repeat(36), "ghu_" + "a".repeat(36), "ghs_x", "github_pat_short", "", null])
    assert.throws(() => assertFineGrainedToken(token), (e) => e instanceof ProviderError && e.code === "FINE_GRAINED_TOKEN_REQUIRED");
  const pat = "github_pat_" + "A1_".repeat(25);
  assert.doesNotThrow(() => assertFineGrainedToken(pat));
  const { gh, calls } = app((call) => {
    assert.equal(call.url, "https://api.github.com/user");
    assert.equal(call.headers.authorization, "token " + pat);
    return { body: { id: 42, login: "octocat" }, headers: { "github-authentication-token-expiration": "2026-12-31 10:00:00 UTC" } };
  });
  await assert.rejects(gh.verifyPat("ghp_" + "a".repeat(36)), (e) => e.code === "FINE_GRAINED_TOKEN_REQUIRED");
  assert.equal(calls.length, 0, "rejected token kinds never reach GitHub");
  assert.deepEqual(await gh.verifyPat(pat), { id: 42, login: "octocat", url: "https://github.com/octocat", tokenExpiresAt: "2026-12-31T10:00:00.000Z" });
  assert.equal(parseTokenExpiry("2026-12-31 10:00:00 +0530"), "2026-12-31T04:30:00.000Z");
  assert.equal(parseTokenExpiry("soon"), null);
  const denied = app(() => ({ status: 401, body: { message: "Bad credentials" } }));
  await assert.rejects(denied.gh.verifyPat(pat), (e) => e.code === "CREDENTIAL_INVALID");
});

test("github: authorize URL with PKCE, code exchange with verifier, refresh rotation and revoke", async () => {
  const { gh, calls } = app((call) => {
    if (call.url === "https://github.com/login/oauth/access_token" && call.body.code)
      return { body: { access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" } };
    if (call.url === "https://github.com/login/oauth/access_token" && call.body.grant_type === "refresh_token")
      return { body: { access_token: "ghu_rotated", expires_in: 28800, refresh_token: "ghr_rotated", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" } };
    if (call.method === "DELETE") return { status: 204 };
    throw new Error("unexpected " + call.url);
  });
  const url = new URL(gh.authorizeUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43) }));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "Iv1.client");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3000/cb");
  assert.equal(url.searchParams.get("state"), "s".repeat(43));
  assert.equal(url.searchParams.get("code_challenge"), "c".repeat(43));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("allow_signup"), "true");
  assert.equal(url.searchParams.get("scope"), null);

  const before = Date.now();
  const tokens = await gh.exchangeCode({ code: "code123", codeVerifier: "v".repeat(64) });
  assert.equal(tokens.accessToken, "ghu_new");
  assert.equal(tokens.refreshToken, "ghr_new");
  assert.ok(Math.abs(Date.parse(tokens.expiresAt) - (before + 28800000)) < 5000);
  const exchange = calls[0];
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.headers.accept, "application/json");
  assert.deepEqual(exchange.body, { client_id: "Iv1.client", client_secret: "app-secret", code: "code123", redirect_uri: "http://localhost:3000/cb", code_verifier: "v".repeat(64) });

  const rotated = await gh.refresh("ghr_new");
  assert.equal(rotated.accessToken, "ghu_rotated");
  assert.equal(rotated.refreshToken, "ghr_rotated");
  assert.equal(calls[1].body.grant_type, "refresh_token");
  assert.equal(calls[1].body.refresh_token, "ghr_new");

  await gh.revoke("ghu_rotated");
  const revoke = calls[2];
  assert.equal(revoke.method, "DELETE");
  // Single-token revocation only: never the whole grant (that would kill newer tokens).
  assert.equal(revoke.url, "https://api.github.com/applications/Iv1.client/token");
  assert.ok(calls.every((c) => !c.url.endsWith("/grant")));
  assert.equal(revoke.headers.authorization, "basic " + Buffer.from("Iv1.client:app-secret").toString("base64"));
  assert.deepEqual(revoke.body, { access_token: "ghu_rotated" });

  const bad = app(() => ({ body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } }));
  await assert.rejects(bad.gh.exchangeCode({ code: "x", codeVerifier: "v".repeat(64) }), (e) => e.code === "OAUTH_EXCHANGE_FAILED");
  const badRefresh = app(() => ({ body: { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." } }));
  await assert.rejects(badRefresh.gh.refresh("ghr_x"), (e) => e.code === "CREDENTIAL_INVALID");
});

const DAY = 86400000;
const isoDay = (offset, now = Date.now()) => new Date(now - offset * DAY).toISOString().slice(0, 10);
function repoNode(id, name, extra = {}) {
  return {
    databaseId: id, name, nameWithOwner: "octocat/" + name, url: "https://github.com/octocat/" + name,
    description: "A project", isFork: false, isArchived: false, pushedAt: new Date(Date.now() - 10 * DAY).toISOString(),
    updatedAt: new Date().toISOString(), stargazerCount: 3, forkCount: 1, owner: { login: "octocat" },
    primaryLanguage: { name: "JavaScript" },
    languages: { edges: [{ size: 3000, node: { name: "JavaScript" } }, { size: 1000, node: { name: "CSS" } }] },
    licenseInfo: { spdxId: "MIT" }, homepageUrl: "", repositoryTopics: { nodes: [{ topic: { name: "web" } }] },
    readmeMd: { byteSize: 900 }, readmeLower: null, readmeRst: null, readmePlain: null, ...extra,
  };
}
function profileGraph() {
  return {
    viewer: { login: "octocat", databaseId: 42 },
    user: {
      login: "octocat", databaseId: 42, url: "https://github.com/octocat",
      publicRepos: { totalCount: 4 },
      repositories: { totalCount: 3, nodes: [repoNode(1, "alpha"), repoNode(2, "beta", { readmeMd: null, description: null }), repoNode(3, "gamma")] },
      pinnedItems: { nodes: [repoNode(2, "beta"), { ...repoNode(9, "secret"), isPrivate: true }] },
      contributionsCollection: {
        contributionCalendar: {
          totalContributions: 30,
          weeks: [{ contributionDays: [
            { date: isoDay(5), contributionCount: 2 }, { date: isoDay(4), contributionCount: 0 },
            { date: isoDay(3), contributionCount: 1 }, { date: isoDay(2), contributionCount: 0 },
            { date: isoDay(1), contributionCount: 4 }, { date: isoDay(0), contributionCount: 3 },
          ] }],
        },
        totalCommitContributions: 25,
        restrictedContributionsCount: 5,
      },
    },
  };
}

test("github: fetchProfile uses GraphQL and contributor stats (202 pending, 204 empty)", async () => {
  const week = Math.floor((Date.now() - 7 * DAY) / 1000);
  const old = Math.floor((Date.now() - 400 * DAY) / 1000);
  const { gh, calls } = app((call) => {
    if (call.url === "https://api.github.com/graphql") {
      assert.match(call.body.query, /pinnedItems\(first: 6, types: \[REPOSITORY\]\)/);
      assert.match(call.body.query, /privacy: PUBLIC/);
      assert.equal(call.body.variables.login, "octocat");
      return { body: { data: profileGraph() } };
    }
    if (call.url.endsWith("/repos/octocat/alpha/stats/contributors"))
      return { body: [{ author: { id: 42, login: "octocat" }, weeks: [{ w: week, a: 120, d: 5, c: 3 }, { w: old, a: 999, d: 0, c: 1 }] }, { author: { id: 7, login: "other" }, weeks: [{ w: week, a: 50 }] }] };
    if (call.url.endsWith("/repos/octocat/beta/stats/contributors")) return { status: 202, body: {} };
    if (call.url.endsWith("/repos/octocat/gamma/stats/contributors")) return { status: 204 };
    throw new Error("unexpected " + call.url);
  });
  const profile = await gh.fetchProfile("ghu_token", { login: "octocat", externalId: "42" });
  assert.equal(calls.filter((c) => c.url.includes("/stats/contributors")).length, 3);
  assert.ok(calls.every((c) => c.headers.authorization === "token ghu_token"));
  assert.deepEqual(profile.linesAdded, { value: 120, counted: 2, eligible: 3, pending: 1 });
  assert.deepEqual(profile.additions, { 1: 120, 3: 0 });
  assert.deepEqual(profile.pinned.map((r) => r.id), [2], "private pinned items are dropped");
  assert.equal(profile.publicRepos, 4);

  const result = githubResult(profile);
  assert.equal(result.status, "partial");
  assert.equal(result.retryStats, true);
  const metrics = Object.fromEntries(result.metrics.map((m) => [m.key, m]));
  assert.equal(metrics["activity.current_streak"].value, 2);
  assert.equal(metrics["activity.longest_streak"].value, 2);
  assert.equal(metrics["activity.active_days"].value, 4);
  assert.match(metrics["activity.current_streak"].note, /UTC/);
  assert.equal(metrics["contributions.lines_added_52w"].verification, "platform_verified");
  assert.match(metrics["languages.top"].note, /not proficiency/);
  assert.equal(metrics["languages.top"].value[0].language, "JavaScript");
  const beta = result.repositories.find((r) => r.repo_id === 2);
  assert.equal(beta.pinned, true);
  assert.equal(beta.pin_order, 1);
  assert.ok(!JSON.stringify(result).includes("ghu_token"));

  await assert.rejects(gh.fetchProfile("ghu_token", { login: "octocat", externalId: "99" }), (e) => e.code === "CREDENTIAL_INVALID");
});

test("github: organisation repositories are collected with commit share; own-repository metrics are unchanged", async () => {
  const week = Math.floor((Date.now() - 7 * DAY) / 1000);
  const orgNode = (id, name, extra = {}) => repoNode(id, name, { nameWithOwner: "dsu-club/" + name, url: "https://github.com/dsu-club/" + name,
    owner: { login: "dsu-club", __typename: "Organization" }, ...extra });
  const { gh, calls } = app((call) => {
    if (call.url === "https://api.github.com/graphql") {
      assert.match(call.body.query, /ownerAffiliations: \[ORGANIZATION_MEMBER\]/);
      const graph = profileGraph();
      graph.user.organizationRepositories = { totalCount: 2, nodes: [orgNode(70, "club-site"), orgNode(71, "forked", { isFork: true })] };
      return { body: { data: graph } };
    }
    if (call.url.endsWith("/repos/dsu-club/club-site/stats/contributors"))
      return { body: [{ author: { id: 42, login: "octocat" }, total: 12, weeks: [{ w: week, a: 400 }] }, { author: { id: 7, login: "other" }, total: 28, weeks: [] }] };
    if (call.url.includes("/stats/contributors")) return { status: 204 };
    throw new Error("unexpected " + call.url);
  });
  const profile = await gh.fetchProfile("ghu_token", { login: "octocat", externalId: "42" });
  assert.deepEqual(profile.organizationRepositories.map((r) => r.nameWithOwner), ["dsu-club/club-site"], "forks are dropped");
  assert.deepEqual(profile.shares[70], { commits: 12, totalCommits: 40, contributors: 2 });
  assert.equal(profile.linesAdded.value, 0, "organisation additions never enter the student's lines-added metric");
  assert.ok(calls.some((c) => c.url.endsWith("/repos/dsu-club/club-site/stats/contributors")));
  const result = githubResult(profile);
  const club = result.repositories.find((r) => r.repo_id === 70);
  assert.deepEqual([club.owner_login, club.evidence.ownerType, club.evidence.stats.commits], ["dsu-club", "Organization", 12]);
  assert.deepEqual(result.snapshot.organizationRepositoryIds, [70]);
});

test("github: primary rate limits are not retried in-process and carry the reset time", async () => {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  let count = 0;
  const { gh } = app(() => {
    count++;
    return { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } };
  });
  await assert.rejects(gh.fetchProfile("ghu_token", { login: "octocat" }), (e) => {
    assert.equal(e.code, "RATE_LIMITED");
    assert.equal(e.retryAt.getTime(), reset * 1000 + 1000);
    return true;
  });
  assert.equal(count, 1);
  const graphRate = classifyGitHubError({ errors: [{ type: "RATE_LIMITED" }], headers: { "x-ratelimit-reset": String(reset) } });
  assert.equal(graphRate.code, "RATE_LIMITED");
  assert.equal(classifyGitHubError({ status: 401 }).code, "CREDENTIAL_INVALID");
  assert.equal(classifyGitHubError({ status: 500 }).code, "PROVIDER_UNAVAILABLE");
});

test("github: streaks, language share, additions and explainable ranking", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const days = ["2026-10-22", "2026-10-21", "2026-10-20", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"].map((date) => ({ date, contributionCount: 1 }));
  assert.deepEqual(contributionStreaks(days, now), { current: 3, longest: 4, activeDays: 7 });
  assert.equal(contributionStreaks([{ date: "2026-10-21", contributionCount: 2 }], now).current, 1, "a streak ending yesterday still counts");
  assert.equal(contributionStreaks([{ date: "2026-10-20", contributionCount: 2 }], now).current, 0);
  assert.deepEqual(languageShare([{ languages: { Go: 300, JS: 100 } }, { isFork: true, languages: { Rust: 9999 } }]), [
    { language: "Go", bytes: 300, share: 75 },
    { language: "JS", bytes: 100, share: 25 },
  ]);
  assert.equal(sumAdditions([{ author: { id: 1, login: "A" }, weeks: [{ w: Math.floor(now / 1000) - 1000, a: 5 }] }], 2, "a", now), 5, "login match is case-insensitive");
  assert.equal(sumAdditions(null, 1, "a", now), 0);
  const plain = { hasReadme: false, languages: {}, isArchived: true, stars: 0 };
  const starred = { ...plain, stars: 50000, forks: 900 };
  assert.deepEqual(scoreRepository(plain, now), scoreRepository(starred, now), "stars and forks never add points");
  const rich = scoreRepository({ hasReadme: true, readmeBytes: 600, description: "x", topics: ["a"], license: "MIT", pushedAt: "2026-10-01T00:00:00Z", isArchived: false, homepage: "https://x.dev", languages: { a: 1, b: 2 } }, now);
  assert.equal(rich.score, 13);
  assert.ok(rich.reasons.includes("README is substantial (500+ bytes)"));
  assert.ok(rich.reasons.includes("Updated in the last 90 days"));
});

// ---- Hugging Face ---------------------------------------------------------------------
test("huggingface: overview counts, top items, 404, rate limit and limits", async () => {
  const seen = [];
  const hf = createHuggingFace({
    fetch: async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/overview")) return new Response(JSON.stringify({ user: "some-user", numModels: 3, numDatasets: 1, numSpaces: 2, avatarUrl: "x" }));
      const kind = url.split("/api/")[1].split("?")[0];
      return new Response(JSON.stringify([
        { id: `some-user/${kind}-low`, likes: 1, downloads: 10, pipeline_tag: "text-classification", lastModified: "2026-01-01T00:00:00.000Z" },
        { id: `some-user/${kind}-high`, likes: 9, createdAt: "2025-01-01T00:00:00.000Z" },
        { id: "../../etc/passwd", likes: 100 },
        { likes: 5 },
      ]));
    },
  });
  const profile = await hf.fetchProfile("some-user");
  assert.deepEqual(profile.counts, { models: 3, datasets: 1, spaces: 2 });
  assert.deepEqual(profile.top.models.map((m) => m.id), ["some-user/models-high", "some-user/models-low"]);
  assert.equal(profile.top.models[1].pipelineTag, "text-classification");
  assert.equal(profile.top.models[0].downloads, null);
  assert.ok(seen.every((s) => s.url.startsWith("https://huggingface.co/api/") && s.init.redirect === "error" && s.init.signal));
  assert.equal(seen[0].url, "https://huggingface.co/api/users/some-user/overview");
  assert.equal(seen[1].url, "https://huggingface.co/api/models?author=some-user&sort=likes&direction=-1&limit=5");
  const result = huggingFaceResult(profile);
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.find((m) => m.key === "models.count").value, 3);

  const encoded = [];
  const missing = createHuggingFace({ fetch: async (url) => (encoded.push(url), new Response("{}", { status: 404 })) });
  await assert.rejects(missing.fetchProfile("a/b?c"), (e) => e.code === "PLATFORM_ACCOUNT_NOT_FOUND");
  assert.equal(encoded[0], "https://huggingface.co/api/users/a%2Fb%3Fc/overview");

  const limited = createHuggingFace({ now: () => 1000, fetch: async () => new Response("", { status: 429, headers: { RateLimit: '"api";r=0;t=35' } }) });
  await assert.rejects(limited.fetchProfile("u"), (e) => e.code === "RATE_LIMITED" && e.retryAt.getTime() === 1000 + 36000);
  assert.equal(rateLimitDelay(new Headers({ ratelimit: '"api";r=499;t=12' })), 12);
  assert.equal(rateLimitDelay(new Headers({ "retry-after": "7" })), 7);

  const huge = createHuggingFace({ fetch: async () => new Response("x".repeat(1024 * 1024 + 10)) });
  await assert.rejects(huge.fetchProfile("u"), (e) => e.code === "PROVIDER_UNAVAILABLE");
  const broken = createHuggingFace({ fetch: async () => new Response("not json") });
  await assert.rejects(broken.fetchProfile("u"), (e) => e.code === "PROVIDER_UNAVAILABLE");
  const down = createHuggingFace({ fetch: async () => { throw new TypeError("fetch failed: redirect"); } });
  await assert.rejects(down.fetchProfile("u"), (e) => e.code === "PROVIDER_UNAVAILABLE");
});

test("devguard: decoded connection checks cannot be bypassed with percent-encoding or overrides", () => {
  const DEV = "abcdefghijklmnopqrst";
  const LIVE = "idioblehzhaibtgotfjk";
  const env = (url, extra = {}) => ({ DSU_ENVIRONMENT: "development", DEV_SUPABASE_URL: `https://${DEV}.supabase.co`, DEV_DATABASE_ADMIN_URL: url, ...extra });
  const check = (url, extra) => staticChecks(env(url, extra), [], {});
  const encode = (text) => [...text].map((c) => "%" + c.charCodeAt(0).toString(16)).join("");

  assert.equal(check(`postgresql://postgres:pw@db.${DEV}.supabase.co:5432/postgres`).ok, true);
  assert.equal(check(`postgresql://postgres.${DEV}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`).ok, true);
  assert.deepEqual(parseDatabaseUrl(`postgresql://postgres.${encode(LIVE)}:p%40w@aws-0-ap-south-1.pooler.supabase.com/${encode("x")}`), {
    user: `postgres.${LIVE}`, host: "aws-0-ap-south-1.pooler.supabase.com", database: "x",
  });
  const refused = (url, pattern, extra) => {
    const result = check(url, extra);
    assert.equal(result.ok, false, url);
    if (pattern) assert.ok(result.reasons.some((r) => pattern.test(r)), url + " " + result.reasons.join("; "));
  };
  // Previously accepted: the protected ref hidden by percent-encoding, with the dev ref placed anywhere in the string.
  refused(`postgresql://postgres.${encode(LIVE)}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?application_name=${DEV}`, /protected project/);
  refused(`postgresql://postgres:pw@db.${encode(LIVE)}.supabase.co:5432/postgres?x=${DEV}`, /protected project/);
  refused(`postgresql://postgres:pw@db.${DEV}.supabase.co:5432/${encode(LIVE)}`, /protected project/);
  // pg honours ?host= and ?user= over the authority part.
  refused(`postgresql://postgres:pw@db.${DEV}.supabase.co:5432/postgres?host=db.${LIVE}.supabase.co`, /protected project/);
  refused(`postgresql://postgres.${DEV}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?user=postgres.${LIVE}`, /protected project/);
  // The host must be exactly the dev project's, or a pooler with user exactly postgres.<devref>.
  refused(`postgresql://postgres:pw@db.${DEV}.supabase.co.evil.example:5432/postgres`, /must be db\.<project-ref>/);
  refused(`postgresql://postgres:pw@evil.example/${DEV}`, /must be db\.<project-ref>/);
  refused(`postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0-ap-south-1.pooler.supabase.com:6543/${DEV}`, /must be db\.<project-ref>/);
  refused(`postgresql://dsu_api.${DEV}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`, /must be db\.<project-ref>/);
  // A shared regional pooler is "the same host" only for the same tenant; the same project is always refused.
  const pooled = `postgresql://postgres.${DEV}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`;
  assert.equal(staticChecks(env(pooled), [], { DATABASE_URL: `postgresql://dsu_api.${LIVE}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres` }).ok, true);
  assert.ok(staticChecks(env(pooled), [], { DATABASE_URL: `postgresql://dsu_api.${DEV}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres` }).reasons.some((r) => /same project as DATABASE_URL/.test(r)));
  // Local databases only with the explicit flag (the database marker checks still run).
  refused("postgresql://postgres:pw@localhost:5432/postgres", /DEV_ALLOW_LOCAL_DB/);
  refused("postgresql://postgres:pw@127.0.0.1:5432/postgres", /DEV_ALLOW_LOCAL_DB/, { DEV_ALLOW_LOCAL_DB: "true" });
  assert.equal(check("postgresql://postgres:pw@localhost:5432/postgres", { DEV_ALLOW_LOCAL_DB: "1" }).ok, true);
  refused(`postgresql://postgres:pw@localhost:5432/${LIVE}`, /protected project/, { DEV_ALLOW_LOCAL_DB: "1" });
  refused("not a url", /must be set/);
});

test("devguard: the Auth user is created only after the rows insert and removed if the transaction fails", async () => {
  const run = async ({ failStudent = false, failMembership = false, failCommit = false } = {}) => {
    const log = [];
    const client = {
      async query(sql) {
        log.push(sql);
        if (sql === "COMMIT" && failCommit) throw new Error("commit failed");
      },
    };
    const outcome = await provisionInTransaction(client, {
      createUser: async () => (log.push("createUser"), { id: "user-1" }),
      deleteUser: async (id) => log.push("deleteUser:" + id),
      insertStudent: async () => {
        log.push("insertStudent");
        if (failStudent) throw new Error("duplicate DEVSTUDENT0001");
      },
      insertMembership: async (_c, id) => {
        log.push("insertMembership:" + id);
        if (failMembership) throw new Error("membership failed");
      },
    }).then((id) => ({ id }), (error) => ({ error: error.message }));
    return { outcome, log };
  };
  let { outcome, log } = await run();
  assert.deepEqual(outcome, { id: "user-1" });
  assert.deepEqual(log, ["BEGIN", "insertStudent", "createUser", "insertMembership:user-1", "COMMIT"]);
  ({ outcome, log } = await run({ failStudent: true }));
  assert.deepEqual(log, ["BEGIN", "insertStudent", "ROLLBACK"], "no Auth user when the rows fail");
  ({ outcome, log } = await run({ failMembership: true }));
  assert.deepEqual(log, ["BEGIN", "insertStudent", "createUser", "insertMembership:user-1", "ROLLBACK", "deleteUser:user-1"]);
  ({ outcome, log } = await run({ failCommit: true }));
  assert.equal(outcome.error, "commit failed");
  assert.deepEqual(log.slice(-2), ["ROLLBACK", "deleteUser:user-1"]);
});
