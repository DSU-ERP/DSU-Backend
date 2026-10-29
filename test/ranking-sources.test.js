import test from "node:test";
import assert from "node:assert/strict";
import { batchQuery, createLeetCode, normalizeLeetCode } from "../src/modules/intelligence/leetcode.js";
import { nameMatch, similarity } from "../src/modules/intelligence/name-match.js";
import { contributorShare, repositoryEvidence } from "../src/modules/intelligence/github.js";
import { leetCodeResult } from "../src/modules/intelligence/sync.js";

const reply = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});
const user = (name, solved) => ({
  username: name,
  profile: { realName: name === "coder" ? "Asha Coder" : "" },
  submitStatsGlobal: { acSubmissionNum: [{ difficulty: "All", count: solved[0] + solved[1] + solved[2] }, { difficulty: "Easy", count: solved[0] }, { difficulty: "Medium", count: solved[1] }, { difficulty: "Hard", count: solved[2] }] },
  tagProblemCounts: {
    fundamental: [{ tagName: "Array", tagSlug: "array", problemsSolved: 70 }, { tagName: "Bad", tagSlug: "<script>", problemsSolved: 3 }],
    intermediate: [{ tagName: "Hash Table", tagSlug: "hash-table", problemsSolved: 30 }],
    advanced: [{ tagName: "Dynamic Programming", tagSlug: "dynamic-programming", problemsSolved: -4 }],
  },
});
// Fake LeetCode: answers each alias from a table of known users.
const known = { coder: user("coder", [60, 55, 15]), second: user("second", [5, 1, 0]) };
const server = (calls, status = 200, headers = {}) => async (url, options) => {
  calls.push({ url, options, body: JSON.parse(options.body) });
  const vars = JSON.parse(options.body).variables;
  const data = {};
  const errors = [];
  for (const [key, name] of Object.entries(vars)) {
    const i = key.slice(1);
    data[`m${i}`] = known[name] ?? null;
    data[`c${i}`] = name === "coder" ? { attendedContestsCount: 7, rating: 1745.6 } : null;
    if (!known[name]) errors.push({ message: "That user does not exist.", path: [`m${i}`] });
  }
  return reply(status, { data, errors }, headers);
};
const quick = (fetch, extra = {}) => createLeetCode({ fetch, minIntervalMs: 0, windowMs: 5, ...extra });

test("LeetCode client: concurrent lookups share one batched request", async () => {
  const calls = [];
  const client = quick(server(calls));
  const [a, b, missing] = await Promise.allSettled([client.fetchProfile("coder"), client.fetchProfile("second"), client.fetchProfile("nobody")]);
  assert.equal(calls.length, 1, "one request for three students");
  assert.equal(calls[0].url, "https://leetcode.com/graphql");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].body.variables, { u0: "coder", u1: "second", u2: "nobody" });
  assert.deepEqual(a.value.solved, { all: 130, easy: 60, medium: 55, hard: 15 });
  assert.deepEqual(a.value.contest, { rating: 1746, attended: 7 });
  assert.equal(a.value.realName, "Asha Coder");
  assert.deepEqual(a.value.tags.map((t) => [t.slug, t.solved]), [["array", 70], ["hash-table", 30]], "invalid slugs and counts are dropped");
  assert.equal(b.value.contest, null);
  assert.equal(b.value.realName, null);
  assert.equal(missing.reason.code, "PLATFORM_ACCOUNT_NOT_FOUND", "a missing user fails alone");
});

test("LeetCode client: batches are capped, deduplicated and spaced", async () => {
  const calls = [];
  const slept = [];
  let clock = 0;
  const client = createLeetCode({ fetch: server(calls), batchSize: 2, windowMs: 5, minIntervalMs: 1500, now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; } });
  await Promise.allSettled(["coder", "CODER", "second", "x1", "x2"].map((u) => client.fetchProfile(u)));
  assert.deepEqual(calls.map((c) => Object.values(c.body.variables)), [["coder", "second"], ["x1", "x2"]], "case-insensitive duplicates share a slot");
  assert.deepEqual(slept, [1500], "requests are spaced");
});

test("LeetCode client: a rate limit pauses every lookup until the reset", async () => {
  const calls = [];
  let clock = 1000;
  const client = quick(server(calls, 429, { "retry-after": "120" }), { now: () => clock });
  const limited = await client.fetchProfile("coder").catch((e) => e);
  assert.deepEqual([limited.code, limited.retryAt.getTime()], ["RATE_LIMITED", 1000 + 121000]);
  const blocked = await client.fetchProfile("second").catch((e) => e);
  assert.deepEqual([blocked.code, calls.length], ["RATE_LIMITED", 1], "no request while paused");
  clock += 122000;
  const resumed = createLeetCode({ fetch: server(calls), minIntervalMs: 0, windowMs: 5, now: () => clock });
  assert.equal((await resumed.fetchProfile("coder")).solved.all, 130);
  // Bot protection (403) is a pause too, never a dead account.
  const refused = await quick(server([], 403)).fetchProfile("coder").catch((e) => e);
  assert.equal(refused.code, "RATE_LIMITED");
});

test("LeetCode client: outages and bad input map to stable codes", async () => {
  assert.equal((await quick(server([], 502)).fetchProfile("coder").catch((e) => e)).code, "PROVIDER_UNAVAILABLE");
  assert.equal((await quick(async () => { throw new Error("offline"); }).fetchProfile("coder").catch((e) => e)).code, "PROVIDER_UNAVAILABLE");
  assert.equal((await quick(async () => reply(200, { errors: [{ message: "boom" }] })).fetchProfile("coder").catch((e) => e)).code, "PROVIDER_UNAVAILABLE");
  const calls = [];
  const bad = await quick(server(calls)).fetchProfile("../etc").catch((e) => e);
  assert.deepEqual([bad.code, calls.length], ["PLATFORM_ACCOUNT_NOT_FOUND", 0], "invalid usernames never reach the network");
  assert.match(batchQuery(2), /m1: matchedUser\(username: \$u1\)/);
});

test("LeetCode result: no contest means no contest metrics; the profile name is not stored", () => {
  const noContest = normalizeLeetCode({ matchedUser: known.coder, userContestRanking: null });
  const result = leetCodeResult(noContest);
  const metrics = result.metrics.map((m) => m.key);
  assert.ok(!metrics.includes("contest.rating"));
  assert.ok(metrics.includes("problems.medium") && metrics.includes("topics.solved"));
  assert.ok(result.metrics.every((m) => m.verification === "platform_verified"));
  assert.equal(result.identity.realName, "Asha Coder");
  assert.ok(!JSON.stringify(result.snapshot).includes("Asha Coder"));
});

test("name match: matching or very similar usernames and profile names are verified", () => {
  const verified = [
    ["SHREYAS K R", { username: "shreyas_kr" }], ["SHREYAS K R", { username: "shreyas2004" }], ["SHREYAS K R", { username: "kshreyas" }],
    ["Ananya Rao", { username: "raoananya" }], ["Mohammed Faisal", { username: "mdfaisal" }], ["Siddharth Venkataraman", { username: "sidvenkat" }],
    ["Ananya Rao", { username: "x", realName: "Ananya R" }], ["José Álvarez", { username: "josealvarez" }],
  ];
  for (const [name, identity] of verified) assert.equal(nameMatch(name, identity).status, "verified", `${name} ${JSON.stringify(identity)}`);
  const unverified = [
    ["SHREYAS K R", { username: "coolcoder99" }], ["Priya Shetty", { username: "priyanka123" }], ["Ananya Rao", { username: "anya" }],
    ["Ananya Rao", { username: "x", realName: "Rahul Sharma" }], ["", { username: "anything" }], ["Priya Shetty", {}],
  ];
  for (const [name, identity] of unverified) assert.equal(nameMatch(name, identity).status, "unverified", `${name} ${JSON.stringify(identity)}`);
  assert.equal(nameMatch("Ananya Rao", { username: "ananyarao", realName: "Ananya Rao" }).source, "profile_name", "the profile name is checked first");
  assert.ok(similarity("abc", "abc") === 1 && similarity("", "abc") === 0);
});

test("GitHub repository evidence: root names only, unreadable trees are not observed", () => {
  const ev = repositoryEvidence({
    rootTree: { entries: [{ name: "package.json", type: "blob" }, { name: "src", type: "tree" }, { name: "__tests__", type: "tree" }, { name: ".gitignore", type: "blob" }, { name: "Dockerfile", type: "blob" }] },
    workflows: { entries: [{ name: "ci.yml" }, { name: "README.md" }] },
    releases: { totalCount: 2 }, diskUsage: 120,
  });
  assert.deepEqual(ev, { observed: true, ownerType: null, rootEntries: 5, manifests: ["package.json"], tests: true, sourceDirs: true, gitignore: true, docker: true, ci: true, workflows: 1, releases: 2, diskKb: 120 });
  assert.equal(repositoryEvidence({ rootTree: null, releases: { totalCount: 0 } }).observed, false);
  assert.equal(repositoryEvidence({ rootTree: { entries: [{ name: "app.test.ts", type: "blob" }] } }).tests, true);
});

test("GitHub commit share counts the student's commits by id or login", () => {
  const stats = [
    { author: { id: 7, login: "dev" }, total: 30 },
    { author: { id: 8, login: "mate" }, total: 10 },
    { author: null, total: 5 },
    { author: { id: 9, login: "bot" }, total: 0 },
  ];
  assert.deepEqual(contributorShare(stats, 7, "dev"), { commits: 30, totalCommits: 45, contributors: 3 });
  assert.deepEqual(contributorShare(stats, 99, "DEV"), { commits: 30, totalCommits: 45, contributors: 3 });
  assert.deepEqual(contributorShare(null, 7, "dev"), { commits: 0, totalCommits: 0, contributors: 0 });
});
