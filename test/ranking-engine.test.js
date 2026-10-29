import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  academicScore,
  classifyRepository,
  dsaFromCounts,
  dsaScore,
  evaluateStudent,
  githubScore,
  scoreRepository,
} from "../src/modules/ranking/engine.js";
import { TOPICS } from "../src/modules/ranking/taxonomy.js";

const model = JSON.parse(readFileSync(new URL("../src/modules/ranking/model-v1.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-10-27T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

const leetcode = (counts, { metrics = {}, ...extra } = {}) => ({
  state: "linked", visible: true, handle: "lc", lastSyncedAt: daysAgo(1), syncError: null, disputed: false,
  metrics: { "problems.easy": counts.easy, "problems.medium": counts.medium, "problems.hard": counts.hard,
    "problems.solved": counts.easy + counts.medium + counts.hard, ...metrics },
  ...extra,
});

// A well-built repository: everything the rubric can observe.
const strongRepo = (id, extra = {}) => ({
  repoId: id, name: `proj${id}`, fullName: `dev/proj${id}`, url: `https://github.com/dev/proj${id}`,
  description: "Placement tracker API", primaryLanguage: "TypeScript", languages: { TypeScript: 400000, CSS: 20000 },
  topics: ["nextjs", "api"], isFork: false, hasReadme: true, readmeBytes: 4000, license: "MIT",
  homepage: "https://example.org", pushedAt: daysAgo(10), ownerLogin: "dev", additions52w: 9000,
  evidence: { observed: true, rootEntries: 14, manifests: ["package.json"], tests: true, sourceDirs: true, gitignore: true,
    docker: true, ci: true, workflows: 2, releases: 1, diskKb: 900, stats: { commits: 80, totalCommits: 100, contributors: 2 } },
  ...extra,
});
const trivialRepo = (id) => ({
  repoId: id, name: `t${id}`, fullName: `dev/t${id}`, url: `https://github.com/dev/t${id}`, description: null,
  primaryLanguage: "HTML", languages: { HTML: 1500 }, topics: [], isFork: false, hasReadme: false, readmeBytes: null,
  license: null, homepage: null, pushedAt: daysAgo(400), ownerLogin: "dev", additions52w: null,
  evidence: { observed: true, rootEntries: 2, manifests: [], tests: false, sourceDirs: false, gitignore: false, docker: false,
    ci: false, workflows: 0, releases: 0, diskKb: 2, stats: null },
});
const github = (repos, extra = {}) => ({ state: "linked", visible: true, handle: "dev", lastSyncedAt: daysAgo(1), syncError: null, repos, ...extra });
const student = (extra = {}) => ({
  id: "00000000-0000-4000-8000-000000000001", cgpa: "8.50", consented: true,
  visibility: { platforms: true, projects: true, activity: true, summary: true },
  leetcode: leetcode({ easy: 100, medium: 120, hard: 20 }), github: github([strongRepo(1), strongRepo(2)]), ...extra,
});

test("academic score uses the verified 10-point CGPA and never invents a value", () => {
  assert.deepEqual([academicScore("8.52", model).status, academicScore("8.52", model).score], ["scored", 85.2]);
  assert.equal(academicScore("10", model).score, 100);
  assert.equal(academicScore("0", model).score, 0);
  assert.deepEqual([academicScore(null, model).status, academicScore(null, model).score], ["missing", null]);
  assert.equal(academicScore("10.4", model).status, "invalid");
  assert.equal(academicScore("-1", model).status, "invalid");
  assert.equal(academicScore("8.50", model).score, academicScore("8.5", model).score, "ties are equal scores");
});

test("DSA: strong medium and hard work beats a pile of easy problems", () => {
  const easySpam = dsaFromCounts({ easy: 900, medium: 10, hard: 0 }, model).score;
  const strong = dsaFromCounts({ easy: 60, medium: 150, hard: 30 }, model).score;
  assert.ok(strong > easySpam + 20, `${strong} vs ${easySpam}`);
  // Easy problems stop counting at the cap.
  assert.equal(dsaFromCounts({ easy: 150, medium: 0, hard: 0 }, model).score, dsaFromCounts({ easy: 5000, medium: 0, hard: 0 }, model).score);
  // Bounded: never exceeds 100.
  assert.ok(dsaFromCounts({ easy: 2000, medium: 3000, hard: 1500 }, model).score <= 100);
});

test("DSA statuses: missing profile, zero activity, missing contest, outage, stale, duplicate claims", () => {
  assert.equal(dsaScore(null, true, model, NOW).status, "not_linked");
  assert.equal(dsaScore({ state: "declared_none" }, true, model, NOW).status, "not_linked");
  const zero = dsaScore(leetcode({ easy: 0, medium: 0, hard: 0 }), true, model, NOW);
  assert.deepEqual([zero.status, zero.score], ["scored", 0], "a verified profile with no solved problems scores 0");
  const plain = dsaScore(leetcode({ easy: 50, medium: 50, hard: 5 }), true, model, NOW);
  const withContest = dsaScore(leetcode({ easy: 50, medium: 50, hard: 5 }, { metrics: { "contest.rating": 1900, "contest.attended": 12 } }), true, model, NOW);
  assert.equal(plain.score, withContest.score, "contest rating is shown, not scored");
  assert.equal(plain.explanation.contestRating, null);
  assert.equal(withContest.explanation.contestRating, 1900);
  const never = dsaScore({ ...leetcode({ easy: 1, medium: 1, hard: 1 }), lastSyncedAt: null, syncError: null }, true, model, NOW);
  assert.deepEqual([never.status, never.score], ["pending", null]);
  const outage = dsaScore({ ...leetcode({ easy: 1, medium: 1, hard: 1 }), lastSyncedAt: null, syncError: "PROVIDER_UNAVAILABLE" }, true, model, NOW);
  assert.deepEqual([outage.status, outage.score], ["unavailable", null]);
  // A failure after a successful sync keeps the verified evidence.
  const kept = dsaScore({ ...leetcode({ easy: 10, medium: 10, hard: 1 }), syncError: "PROVIDER_UNAVAILABLE" }, true, model, NOW);
  assert.equal(kept.status, "scored");
  const stale = dsaScore({ ...leetcode({ easy: 10, medium: 10, hard: 1 }), lastSyncedAt: daysAgo(45) }, true, model, NOW);
  assert.equal(stale.status, "stale");
  assert.ok(stale.score > 0 && /45 days old/.test(stale.reason));
  assert.equal(dsaScore({ ...leetcode({ easy: 10, medium: 10, hard: 1 }), disputed: true }, true, model, NOW).status, "disputed");
  assert.equal(dsaScore(leetcode({ easy: 10, medium: 10, hard: 1 }), false, model, NOW).status, "hidden");
  const partial = leetcode({ easy: 10, medium: 10, hard: 1 });
  delete partial.metrics["problems.hard"];
  assert.equal(dsaScore(partial, true, model, NOW).status, "unavailable");
});

test("GitHub: few strong projects beat many trivial ones; forks never count", () => {
  const few = githubScore(github([strongRepo(1), strongRepo(2)]), true, model, NOW);
  const many = githubScore(github(Array.from({ length: 30 }, (_, i) => trivialRepo(100 + i))), true, model, NOW);
  assert.ok(few.score > 50 && many.score < 20, `${few.score} vs ${many.score}`);
  const forks = githubScore(github([{ ...strongRepo(1), isFork: true }]), true, model, NOW);
  assert.deepEqual([forks.status, forks.score, forks.explanation.repositoriesConsidered], ["scored", 0, 0]);
  // Someone else's repository pinned on the profile is not the student's work.
  const foreign = githubScore(github([{ ...strongRepo(1), ownerLogin: "other-org" }]), true, model, NOW);
  assert.equal(foreign.score, 0);
  // Breadth adds at most 5 points.
  const breadth = githubScore(github(Array.from({ length: 12 }, (_, i) => strongRepo(i + 1))), true, model, NOW);
  assert.equal(breadth.explanation.breadth.points, 5);
  assert.ok(breadth.score <= 100);
});

test("GitHub: organisation repositories count only with the student's own commits", () => {
  const org = (id, stats) => strongRepo(id, { ownerLogin: "dsu-club", fullName: `dsu-club/p${id}`,
    evidence: { ...strongRepo(id).evidence, ownerType: "Organization", stats } });
  const counted = org(50, { commits: 30, totalCommits: 100, contributors: 6 });
  const tooFew = org(51, { commits: 2, totalCommits: 4, contributors: 2 });
  const tooSmallShare = org(52, { commits: 9, totalCommits: 200, contributors: 9 });
  const noStats = org(53, null);
  const otherUser = strongRepo(54, { ownerLogin: "classmate", evidence: { ...strongRepo(54).evidence, ownerType: "User" } });
  const r = githubScore(github([counted, tooFew, tooSmallShare, noStats, otherUser]), true, model, NOW);
  assert.equal(r.status, "scored");
  assert.deepEqual([r.explanation.organizationRepositoriesFound, r.explanation.organizationRepositoriesCounted, r.explanation.repositoriesConsidered], [4, 1, 0]);
  assert.deepEqual(r.explanation.top.map((t) => [t.name, t.organization]), [["dsu-club/p50", true]]);
  // No ownership points for an organisation repository; they leave the maximum instead.
  assert.equal(r.explanation.top[0].parts.attribution.observedMax, 10);
  assert.ok(r.explanation.top[0].reasons.some((x) => /Organisation repository/.test(x)));
  // An organisation repository alone is enough for a GitHub score; none at all is a 0 with a reason.
  assert.ok(r.score > 0);
  const none = githubScore(github([tooFew, noStats]), true, model, NOW);
  assert.deepEqual([none.status, none.score], ["scored", 0]);
  assert.match(none.reason, /no organisation repositories with the student's own commits/);
  // Own repositories are unaffected and still carry their ownership points.
  const mixed = githubScore(github([strongRepo(1), counted]), true, model, NOW);
  assert.equal(mixed.explanation.top.find((t) => !t.organization).parts.attribution.observedMax, 15);
});

test("GitHub rubric rewards observable evidence and skips what could not be observed", () => {
  const full = scoreRepository(strongRepo(1), model, NOW);
  const noTests = scoreRepository(strongRepo(1, { evidence: { ...strongRepo(1).evidence, tests: false, ci: false } }), model, NOW);
  const noDocs = scoreRepository(strongRepo(1, { hasReadme: false, readmeBytes: null, description: null, homepage: null, topics: [] }), model, NOW);
  assert.equal(full.parts.testing.earned, 15);
  assert.equal(noTests.parts.testing.earned, 0);
  assert.equal(noDocs.parts.documentation.earned, 0);
  assert.ok(full.score > noTests.score && full.score > noDocs.score);
  // Missing contributor statistics leave 20 points unobserved instead of zero.
  const unobserved = scoreRepository(strongRepo(1, { additions52w: null, evidence: { ...strongRepo(1).evidence, stats: null } }), model, NOW);
  assert.equal(unobserved.observedMax, 80);
  assert.ok(unobserved.score > 85, "unobserved data does not lower the score: " + unobserved.score);
  // Stars and forks never add points.
  assert.equal(scoreRepository(strongRepo(1, { stars: 5000, forks: 900 }), model, NOW).score, full.score);
  // An unreadable repository is not scored at all.
  assert.equal(scoreRepository(strongRepo(1, { evidence: { observed: false } }), model, NOW).evaluated, false);
  const unreadable = githubScore(github([strongRepo(1, { evidence: { observed: false } })]), true, model, NOW);
  assert.deepEqual([unreadable.status, unreadable.score], ["unavailable", null]);
});

test("GitHub statuses: not linked, revoked token, never synced, stale, not shared", () => {
  assert.equal(githubScore(null, true, model, NOW).status, "not_linked");
  const revokedNever = githubScore(github([], { lastSyncedAt: null, syncError: "CREDENTIAL_INVALID" }), true, model, NOW);
  assert.equal(revokedNever.status, "unavailable");
  const revokedEarlier = githubScore(github([strongRepo(1)], { syncError: "CREDENTIAL_INVALID" }), true, model, NOW);
  assert.equal(revokedEarlier.status, "scored", "earlier verified evidence is kept until it goes stale");
  const stale = githubScore(github([strongRepo(1)], { lastSyncedAt: daysAgo(31), syncError: "CREDENTIAL_INVALID" }), true, model, NOW);
  assert.equal(stale.status, "stale");
  assert.match(stale.reason, /CREDENTIAL_INVALID/);
  assert.equal(githubScore(github([strongRepo(1)]), false, model, NOW).status, "hidden");
  // Synced before structural evidence existed: pending until the next GitHub sync, never "unavailable".
  const legacy = githubScore(github([strongRepo(1, { evidence: {} }), strongRepo(2)]), true, model, NOW);
  assert.deepEqual([legacy.status, legacy.score], ["pending", null]);
  assert.match(legacy.reason, /next GitHub sync/);
});

test("project areas are deterministic labels, not mastery", () => {
  assert.deepEqual(classifyRepository(strongRepo(1)), ["project.backend", "project.cloud-devops", "project.fullstack", "project.web"]);
  assert.deepEqual(classifyRepository({ name: "cnn-classifier", description: "PyTorch image model", topics: [], primaryLanguage: "Python", languages: { Python: 1 }, evidence: {} }),
    ["project.ml", "project.python"]);
  assert.deepEqual(classifyRepository({ name: "notes", description: "Lecture notes", topics: [], primaryLanguage: null, languages: {}, evidence: {} }), []);
});

test("combined developer score: weights, no redistribution, reproducibility, model versions", () => {
  const r = evaluateStudent(student(), model, NOW);
  assert.equal(r.developer.status, "scored");
  const expected = 0.5 * r.academic.score + 0.3 * r.dsa.score + 0.2 * r.github.score;
  assert.ok(Math.abs(r.developer.score - expected) < 0.01);
  assert.deepEqual(r.developer.explanation.weights, { academic: 0.5, dsa: 0.3, github: 0.2 });
  assert.equal(r.evidenceState, "complete");
  assert.equal(r.coverage, 1);

  // Same inputs, same result and hash.
  const again = evaluateStudent(student(), model, NOW);
  assert.deepEqual(again, r);
  // A different model version changes the input hash even with identical inputs.
  assert.notEqual(evaluateStudent(student(), { ...model, version: "developer-competency-v2-test" }, NOW).inputHash, r.inputHash);

  // Missing LeetCode: pending, not a redistributed or zero-filled composite.
  const noLc = evaluateStudent(student({ leetcode: null }), model, NOW);
  assert.deepEqual([noLc.developer.status, noLc.developer.score], ["pending", null]);
  assert.equal(noLc.coverage, 0.7);
  assert.equal(noLc.evidenceState, "partial");
  assert.ok(noLc.developer.explanation.blockers.some((b) => b.startsWith("DSA: LeetCode is not linked")));
  // Stale evidence keeps component scores but holds the composite.
  const stale = evaluateStudent(student({ github: github([strongRepo(1)], { lastSyncedAt: daysAgo(40) }) }), model, NOW);
  assert.deepEqual([stale.github.status, stale.developer.status], ["stale", "pending"]);
  // No CGPA: never ranked academically, composite pending.
  const noCgpa = evaluateStudent(student({ cgpa: null }), model, NOW);
  assert.deepEqual([noCgpa.academic.status, noCgpa.developer.status, noCgpa.evidenceState], ["missing", "pending", "pending"]);
  // Without consent, platform data is not used at all.
  const noConsent = evaluateStudent(student({ consented: false }), model, NOW);
  assert.deepEqual([noConsent.dsa.status, noConsent.github.status, noConsent.topics.length], ["hidden", "hidden", 0]);
  // Projects hidden from officers: GitHub not used, LeetCode still used.
  const noProjects = evaluateStudent(student({ visibility: { platforms: true, projects: false } }), model, NOW);
  assert.deepEqual([noProjects.dsa.status, noProjects.github.status], ["scored", "hidden"]);
});

test("department fairness: the engine never reads the department or programme", () => {
  const cse = evaluateStudent({ ...student(), department: "CSE" }, model, NOW);
  const mech = evaluateStudent({ ...student(), department: "MECH" }, model, NOW);
  for (const k of ["academic", "dsa", "github", "developer"]) assert.equal(cse[k].score, mech[k].score);
});

test("topics: DSA only from verified LeetCode tags above the minimum; no core-subject scores", () => {
  const tags = [{ slug: "dynamic-programming", solved: 40 }, { slug: "array", solved: 2 }, { slug: "tree", solved: 5 }, { slug: "binary-tree", solved: 25 }];
  const r = evaluateStudent(student({ leetcode: leetcode({ easy: 50, medium: 60, hard: 10 }, { metrics: { "topics.solved": tags } }) }), model, NOW);
  const codes = r.topics.map((t) => t.code);
  assert.ok(codes.includes("dsa.dynamic-programming"));
  assert.ok(!codes.includes("dsa.arrays"), "2 solved is below the evidence minimum");
  const trees = r.topics.find((t) => t.code === "dsa.trees");
  assert.equal(trees.evidence.solved, 25, "overlapping tags use the largest count, never a sum");
  assert.ok(codes.includes("project.web"));
  assert.ok(!codes.some((c) => c.startsWith("core.") || c === "spec.ai"), "no fabricated subject mastery");
  for (const t of r.topics) assert.ok(t.score > 0 && t.score <= 100);
  // Every scored topic exists in the taxonomy with a matching source.
  const known = new Map(TOPICS.map((t) => [t.code, t.source]));
  for (const t of r.topics) assert.equal(known.get(t.code), t.source);
});
