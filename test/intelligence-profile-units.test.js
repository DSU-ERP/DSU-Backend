import test from "node:test";
import assert from "node:assert/strict";
import { readinessNotes } from "../src/modules/intelligence/readiness-notes.js";
import { buildEvidence, groundSummary, evidenceHash, evidenceSources } from "../src/modules/intelligence/summary.js";
import { normalizeVisibility } from "../src/modules/intelligence/profile-service.js";

const noScores = (readiness) => {
  for (const item of readiness.items) for (const value of Object.values(item)) assert.equal(typeof value, "string");
  assert.ok(!JSON.stringify(readiness).includes("—"));
};

test("readiness with no data reports unavailable and not provided, never low ability", () => {
  const r = readinessNotes({ academic: { cgpa: null, eligible: null }, onboarding: { complete: false, missing: ["identity", "github"] } });
  noScores(r);
  const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.equal(by.academic_eligibility.state, "unavailable");
  assert.equal(by.verified_projects.state, "missing");
  assert.match(by.verified_projects.detail, /^Not provided\..*says nothing about ability/);
  assert.match(by.coding_platforms.detail, /not evidence of skill level/);
  assert.match(by.missing_information.detail, /official CGPA, Identity confirmation and GitHub/);
});

test("readiness for an ineligible student states the CGPA rule only", () => {
  const r = readinessNotes({ academic: { cgpa: "6.10", eligible: false }, onboarding: { complete: true } });
  noScores(r);
  assert.equal(r.items[0].state, "missing");
  assert.match(r.items[0].detail, /decided by official CGPA only/);
  assert.equal(r.items.at(-1).state, "met");
});

test("visibility normalisation matches the SQL rule", () => {
  assert.deepEqual(normalizeVisibility(null), { platforms: true, projects: true, activity: true, summary: true });
  assert.deepEqual(normalizeVisibility({ platforms: "yes", projects: false }), { platforms: false, projects: false, activity: true, summary: true });
});

test("evidence respects visibility and never carries URLs", () => {
  const profile = {
    academic: { program: "B.Tech", department: "CSE", cgpa: "8.00", categoryLabel: "Medium", eligible: true },
    ranking: { batchRank: 2, batchSize: 10, categoryRank: 1, categorySize: 4 },
    visibility: { platforms: false, projects: true, activity: true, summary: true },
    accounts: [{ platform: "github", state: "linked", visible: true, handle: "h", ownership: "platform_verified", metrics: [], submitted: {} },
      { platform: "hackerrank", state: "linked", visible: true, ownership: "student_submitted", metrics: [],
        submitted: { certifications: [{ name: "SQL", url: "https://www.hackerrank.com/certificates/abc" }] } }],
    github: { featured: [], repositories: [{ name: "r", fullName: "h/r", url: "https://github.com/h/r", description: "d" }], activity: [] },
  };
  const evidence = buildEvidence(profile, { phone: "123", skills: "Go" });
  const text = JSON.stringify(evidence);
  assert.ok(!text.includes("https://"));
  assert.ok(!text.includes("SQL")); // platforms hidden
  assert.ok(text.includes("Repository r"));
  assert.ok(!text.includes("123"));
  assert.deepEqual(evidence.map((e) => e.id), evidence.map((_, i) => "e" + (i + 1)));
  assert.equal(evidenceHash(evidence), evidenceHash(JSON.parse(text)));
});

test("evidence records the platform and the groups a summary depends on", () => {
  const profile = {
    academic: { cgpa: "8.00", eligible: true },
    visibility: { platforms: true, projects: true, activity: true, summary: true },
    accounts: [
      { platform: "github", state: "linked", visible: true, handle: "h", ownership: "platform_verified", metrics: [{ metric: "repos.public", value: 3 }], submitted: {} },
      { platform: "leetcode", state: "linked", visible: true, handle: "l", metrics: [], submitted: { solved: 10 } },
      { platform: "kaggle", state: "linked", visible: false, handle: "k", metrics: [], submitted: {} },
    ],
    github: { featured: [], repositories: [{ name: "r", fullName: "h/r", description: "d" }], activity: [{ metric: "activity.active_days", value: 4 }] },
  };
  const evidence = buildEvidence(profile, { skills: "Go" });
  for (const item of evidence.filter((e) => ["platform", "metric", "submitted", "project", "activity"].includes(e.kind))) assert.ok(item.platform, item.label);
  assert.deepEqual(evidenceSources(evidence), ["activity", "platforms:github", "platforms:leetcode", "projects"]);
  // Academic and self-listed evidence alone needs no shared group.
  assert.deepEqual(evidenceSources(buildEvidence({ academic: { cgpa: "8.00", eligible: true } }, { skills: "Go" })), []);
});

test("grounding drops uncited claims and tidies dashes", () => {
  const evidence = [{ id: "e1" }, { id: "e2" }];
  const content = groundSummary({
    summary: { text: "A — B", evidence: ["e1"] },
    skills: [{ name: "Go", evidence: ["e2", "e2"] }, { name: "X", evidence: ["e1", "e7"] }],
    projects: [], academicStrengths: [], achievements: [{ text: "Invented", evidence: [] }],
    developmentAreas: [{ text: "Score 8 out of 10", evidence: ["e1"] }], potentialRoles: [],
  }, evidence);
  assert.equal(content.summary.text, "A, B");
  assert.deepEqual(content.skills, [{ name: "Go", evidence: ["e2"] }]);
  assert.deepEqual([content.achievements, content.developmentAreas], [[], []]);
  assert.throws(() => groundSummary({ summary: { text: "x", evidence: [] }, skills: [], projects: [], academicStrengths: [], achievements: [], developmentAreas: [], potentialRoles: [] }, evidence),
    (e) => e.code === "AI_INVALID_RESPONSE");
});
