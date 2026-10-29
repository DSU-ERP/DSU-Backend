// Students Ranking scoring engine. Pure and deterministic: the same inputs and
// model always give the same scores, so every stored score can be reproduced
// and explained. No database, network or AI calls. See
// docs/student-ranking/scoring-v1.md for the rules in prose.
import { createHash } from "node:crypto";
import { TOPICS } from "./taxonomy.js";

const DAY = 86400000;
const round2 = (x) => Math.round(x * 100) / 100;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const saturate = (x, k) => 100 * (1 - Math.exp(-x / k));
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/**
 * Component statuses. Only `scored` and `stale` carry a number.
 * not_linked: no linked profile. hidden: the student has not shared it with
 * officers. pending: linked, never synced. unavailable: synced data cannot be
 * used (provider failure before any data, unreadable content). stale: data
 * older than the model's freshness window. disputed: the same LeetCode
 * username is linked by another student. missing/invalid: CGPA problems.
 */
export const STATUSES = Object.freeze(["scored", "stale", "not_linked", "hidden", "pending", "unavailable", "disputed", "missing", "invalid"]);
export const HAS_SCORE = new Set(["scored", "stale"]);

const component = (status, score = null, reason = null, explanation = {}) => ({ status, score: score === null ? null : round2(score), reason, explanation });

// ---- Academic -----------------------------------------------------------------
export function academicScore(cgpaValue, model) {
  const cgpa = num(cgpaValue);
  if (cgpa === null) return component("missing", null, "No official CGPA is recorded.");
  if (!Number.isFinite(cgpa) || cgpa < 0 || cgpa > model.academic.scale)
    return component("invalid", null, `The recorded CGPA is outside 0 to ${model.academic.scale}.`);
  return component("scored", (cgpa / model.academic.scale) * 100, null, { cgpa, scale: model.academic.scale, formula: `CGPA / ${model.academic.scale} x 100` });
}

// ---- Shared platform state --------------------------------------------------------
const LABEL = { leetcode: "LeetCode", github: "GitHub" };

/** Status of a platform account before its data is scored, or null when it can be scored. */
export function platformGate(platform, account, shared, model, now) {
  const name = LABEL[platform];
  if (!account || account.state !== "linked") return { status: "not_linked", reason: `${name} is not linked.` };
  if (!shared) return { status: "hidden", reason: `The student has not shared ${name} with placement officers.` };
  if (account.disputed) return { status: "disputed", reason: `This ${name} username is also linked by another student. It is excluded until resolved.` };
  if (!account.lastSyncedAt)
    return account.syncError
      ? { status: "unavailable", reason: `${name} data could not be collected yet (${account.syncError}).` }
      : { status: "pending", reason: `${name} data has not been collected yet.` };
  const ageDays = (now - Date.parse(account.lastSyncedAt)) / DAY;
  return { stale: ageDays > model.freshnessDays, ageDays: Math.floor(ageDays) };
}

const staleReason = (platform, gate, account, model) =>
  `${LABEL[platform]} data is ${gate.ageDays} days old (limit ${model.freshnessDays}).` +
  (account.syncError ? ` The last refresh failed (${account.syncError}).` : "");

// ---- DSA (LeetCode) ----------------------------------------------------------------
export function dsaFromCounts({ easy, medium, hard }, model) {
  const c = model.dsa;
  const weighted = Math.min(easy, c.easyCap) * c.difficulty.easy + medium * c.difficulty.medium + hard * c.difficulty.hard;
  const volume = saturate(weighted, c.volumeK);
  const advanced = saturate(medium + 2 * hard, c.advancedK);
  return {
    score: c.mix.volume * volume + c.mix.advanced * advanced,
    parts: { weighted, volume: round2(volume), advanced: round2(advanced), easyCounted: Math.min(easy, c.easyCap) },
  };
}

export function dsaScore(account, shared, model, now) {
  const gate = platformGate("leetcode", account, shared, model, now);
  if (gate.status) return component(gate.status, null, gate.reason);
  const m = account.metrics || {};
  const [easy, medium, hard] = ["problems.easy", "problems.medium", "problems.hard"].map((k) => num(m[k]));
  if ([easy, medium, hard].some((v) => v === null || !Number.isFinite(v) || v < 0))
    return component("unavailable", null, "LeetCode did not return solved counts by difficulty.");
  const { score, parts } = dsaFromCounts({ easy, medium, hard }, model);
  const contestRating = num(m["contest.rating"]);
  return component(gate.stale ? "stale" : "scored", score, gate.stale ? staleReason("leetcode", gate, account, model) : null, {
    easy, medium, hard,
    solved: num(m["problems.solved"]),
    ...parts,
    contestRating,
    contestsAttended: num(m["contest.attended"]),
    contestNote: "Contest rating is shown for context and is not part of the v1 score.",
    nameMatch: account.nameMatch ?? null,
    nameMatchSource: account.nameMatchSource ?? null,
    formula: `0.6 x volume + 0.4 x advanced; volume = 100(1 - e^(-W/${model.dsa.volumeK})), W = min(easy, ${model.dsa.easyCap}) + 3 x medium + 6 x hard; advanced = 100(1 - e^(-(medium + 2 x hard)/${model.dsa.advancedK}))`,
    syncedAt: account.lastSyncedAt,
  });
}

// ---- GitHub ---------------------------------------------------------------------------
const log10 = Math.log10;

/**
 * Scores one repository against the v1 rubric (six parts, 100 points).
 * Points that need data GitHub did not provide are left out of the maximum
 * rather than scored as zero. Stars, forks and commit counts never add points.
 */
export function scoreRepository(repo, model, now, { organization = false } = {}) {
  const ev = repo.evidence || {};
  if (!ev.observed) return { evaluated: false, reason: "Repository contents could not be read (empty repository or no default branch)." };
  const parts = {};
  const reasons = [];
  let earned = 0, unobserved = 0;
  const part = (key, max) => (parts[key] = { earned: 0, max, observedMax: max });
  const award = (key, points, reason) => {
    if (points <= 0) return;
    parts[key].earned += points;
    earned += points;
    reasons.push(reason);
  };
  const skip = (key, points) => {
    parts[key].observedMax -= points;
    unobserved += points;
  };

  part("implementation", 30);
  const bytes = Object.values(repo.languages || {}).reduce((s, b) => s + (Number(b) || 0), 0);
  award("implementation", 18 * clamp01(log10(Math.max(bytes, 1) / 1000) / 3), `About ${Math.round(bytes / 1000)} KB of code`);
  if (Object.keys(repo.languages || {}).length >= 2) award("implementation", 4, "Uses more than one language");
  if (repo.additions52w === null || repo.additions52w === undefined) skip("implementation", 8);
  else award("implementation", 8 * clamp01(log10(1 + repo.additions52w) / 4), `${repo.additions52w} lines added by the student in 52 weeks`);

  part("organization", 20);
  if (ev.manifests?.length) award("organization", 8, `Dependency or build manifest (${ev.manifests.slice(0, 3).join(", ")})`);
  if (ev.sourceDirs) award("organization", 4, "Code organised in source folders");
  if (repo.license) award("organization", 3, "Has a license");
  if (ev.gitignore) award("organization", 2, "Has a .gitignore");
  if (ev.rootEntries > 0 && ev.rootEntries <= 40) award("organization", 3, "Uncluttered top level");

  part("testing", 15);
  if (ev.tests) award("testing", 9, "Has automated tests");
  if (ev.ci) award("testing", 6, "Has continuous integration");

  part("documentation", 15);
  if (repo.hasReadme && repo.readmeBytes >= 300) award("documentation", 5, "Has a README");
  if (repo.hasReadme && repo.readmeBytes >= 1500) award("documentation", 4, "README is detailed (1,500+ bytes)");
  if (repo.description) award("documentation", 2, "Has a description");
  if (repo.homepage) award("documentation", 2, "Has a homepage or demo link");
  if (repo.topics?.length) award("documentation", 2, "Has topics");

  part("attribution", 15);
  if (organization) {
    // Owned by an organisation: credit comes from the student's commit share alone.
    skip("attribution", 5);
    reasons.push("Organisation repository: credited for the student's own commits");
  } else award("attribution", 5, "Original repository owned by the student");
  const stats = ev.stats;
  if (!stats || !stats.totalCommits) skip("attribution", 10);
  else {
    const share = stats.commits / stats.totalCommits;
    award("attribution", 10 * clamp01(share / 0.5), `Student authored ${Math.round(share * 100)}% of commits`);
  }

  part("maintenance", 5);
  const pushed = repo.pushedAt ? (now - Date.parse(repo.pushedAt)) / DAY : Infinity;
  if (pushed <= 180) award("maintenance", 3, "Updated in the last 180 days");
  else if (pushed <= 365) award("maintenance", 1.5, "Updated in the last year");
  if (!stats || !stats.totalCommits) skip("maintenance", 2);
  else if (stats.contributors >= 2) award("maintenance", 2, "More than one contributor");

  const observedMax = 100 - unobserved;
  if (observedMax < model.github.minObservedShare * 100)
    return { evaluated: false, reason: "Too little of this repository could be observed to score it." };
  for (const p of Object.values(parts)) p.earned = round2(p.earned);
  return { evaluated: true, score: round2((100 * earned) / observedMax), observedMax, parts, reasons };
}

const words = (repo) => new Set(
  [repo.name, repo.description, ...(repo.topics || [])].join(" ").toLowerCase().split(/[^a-z0-9+#.-]+/).filter(Boolean),
);
const any = (set, list) => list.some((w) => set.has(w));

/** Deterministic project-area labels from languages, topics, names and root files. Evidence, not mastery. */
export function classifyRepository(repo) {
  const langs = new Set(Object.keys(repo.languages || {}).map((l) => l.toLowerCase()));
  const primary = String(repo.primaryLanguage || "").toLowerCase();
  const w = words(repo);
  const manifests = new Set(repo.evidence?.manifests || []);
  const areas = new Set();
  const web = any(w, ["react", "nextjs", "next.js", "vue", "angular", "svelte", "frontend", "website", "web", "html", "css", "tailwindcss", "webapp", "portfolio"])
    || ["javascript", "typescript"].includes(primary) && (langs.has("html") || langs.has("css") || langs.has("vue") || langs.has("svelte"))
    || ["html", "css", "vue", "svelte"].includes(primary);
  const backend = any(w, ["backend", "api", "rest-api", "restful", "server", "express", "expressjs", "django", "flask", "fastapi", "spring", "spring-boot", "springboot", "nestjs", "graphql", "microservices", "nodejs", "node.js"]);
  if (web) areas.add("project.web");
  if (backend) areas.add("project.backend");
  if (web && backend) areas.add("project.fullstack");
  if (primary === "python") areas.add("project.python");
  if (primary === "java") areas.add("project.java");
  if (repo.evidence?.docker || langs.has("hcl") || any(w, ["docker", "kubernetes", "k8s", "terraform", "aws", "azure", "gcp", "devops", "ci-cd", "cicd", "ansible", "helm"]))
    areas.add("project.cloud-devops");
  if (["kotlin", "swift", "dart", "objective-c"].includes(primary) || manifests.has("pubspec.yaml") || any(w, ["android", "ios", "flutter", "react-native", "mobile"]))
    areas.add("project.mobile");
  if (any(w, ["machine-learning", "deep-learning", "ml", "pytorch", "tensorflow", "keras", "scikit-learn", "sklearn", "nlp", "computer-vision", "llm", "neural-network", "transformers", "cnn"]))
    areas.add("project.ml");
  if (primary === "jupyter notebook" || any(w, ["data-science", "data-analysis", "pandas", "data-visualization", "eda", "kaggle", "analytics", "tableau", "power-bi"]))
    areas.add("project.data-science");
  if (any(w, ["security", "cybersecurity", "ctf", "pentest", "penetration-testing", "cryptography", "malware", "vulnerability", "exploit", "forensics"]))
    areas.add("project.cybersecurity");
  if (manifests.has("platformio.ini") || langs.has("assembly") || any(w, ["arduino", "esp32", "esp8266", "embedded", "stm32", "raspberry-pi", "iot", "firmware", "microcontroller", "rtos"]))
    areas.add("project.embedded");
  if ((manifests.has("package.xml") && manifests.has("cmakelists.txt")) || any(w, ["ros", "ros2", "robotics", "robot", "slam", "gazebo", "drone"]))
    areas.add("project.robotics");
  return [...areas].sort();
}

export function githubScore(account, shared, model, now) {
  const gate = platformGate("github", account, shared, model, now);
  if (gate.status) return { ...component(gate.status, null, gate.reason), repositories: [] };
  const handle = String(account.handle || "").toLowerCase();
  const repos = (account.repos || []).filter((r) => !r.isFork);
  const mine = (r) => !r.ownerLogin || r.ownerLogin.toLowerCase() === handle;
  const own = repos.filter(mine);
  // Organisation repositories count only with attributable work: enough of the
  // student's own commits in GitHub's contributor statistics.
  const rule = { minCommits: 3, minShare: 0.1, ...(model.github.organization || {}) };
  const orgCandidates = repos.filter((r) => !mine(r) && r.evidence?.ownerType === "Organization");
  const attributable = (r) => {
    const st = r.evidence?.stats;
    return !!st && st.totalCommits > 0 && st.commits >= rule.minCommits && st.commits / st.totalCommits >= rule.minShare;
  };
  const orgCounted = orgCandidates.filter(attributable);
  const considered = [...own, ...orgCounted];
  // Repositories synced before structural evidence existed carry an empty
  // evidence object until their next GitHub sync: that is pending, not unreadable.
  if (own.some((r) => !("observed" in (r.evidence || {}))))
    return { ...component("pending", null, "GitHub repository details are being collected at the next GitHub sync."), repositories: [] };
  const results = considered
    .map((r) => ({ repo: r, organization: !mine(r), ...scoreRepository(r, model, now, { organization: !mine(r) }), areas: classifyRepository(r) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(a.repo.fullName).localeCompare(String(b.repo.fullName)));
  const evaluated = results.filter((r) => r.evaluated);
  const stale = gate.stale ? staleReason("github", gate, account, model) : null;
  const status = gate.stale ? "stale" : "scored";
  if (considered.length && !evaluated.length)
    return { ...component("unavailable", null, "No repository could be read well enough to score."), repositories: results };
  const g = model.github;
  const top = evaluated.slice(0, g.topWeights.length);
  const weighted = top.reduce((s, r, i) => s + g.topWeights[i] * r.score, 0);
  const extra = evaluated.slice(g.topWeights.length).filter((r) => r.score >= g.breadthThreshold).length;
  const breadth = Math.min(g.breadthMax, extra * g.breadthPerRepo);
  const score = considered.length ? g.topShare * weighted + breadth : 0;
  return {
    ...component(status, score, stale ?? (considered.length ? null : "No original public repositories, and no organisation repositories with the student's own commits."), {
      repositoriesConsidered: own.length,
      organizationRepositoriesFound: orgCandidates.length,
      organizationRepositoriesCounted: orgCounted.length,
      organizationRule: `Organisation repositories count when the student authored at least ${rule.minCommits} commits and ${Math.round(rule.minShare * 100)}% of all commits.`,
      repositoriesScored: evaluated.length,
      top: top.map((r, i) => ({ name: r.repo.fullName, url: r.repo.url, score: r.score, weight: g.topWeights[i], parts: r.parts, reasons: r.reasons, areas: r.areas, organization: r.organization })),
      breadth: { qualifyingRepositories: extra, points: breadth, threshold: g.breadthThreshold, max: g.breadthMax },
      formula: `${g.topShare} x (${g.topWeights.join(" / ")} weighted best three repositories) + breadth (1 point per further repository scoring ${g.breadthThreshold}+, at most ${g.breadthMax})`,
      note: "Public, non-fork repositories: the student's own, and organisation repositories with enough of their own commits. Stars, forks and commit counts never add points.",
      syncedAt: account.lastSyncedAt,
    }),
    repositories: results,
  };
}

// ---- Topics ------------------------------------------------------------------------------
export function topicScores(dsa, leetcode, github, model) {
  const out = [];
  if (HAS_SCORE.has(dsa.status)) {
    const tags = new Map((leetcode.metrics?.["topics.solved"] || []).map((t) => [t.slug, Number(t.solved) || 0]));
    for (const t of TOPICS.filter((x) => x.source === "leetcode")) {
      const matched = t.leetcodeTags.filter((s) => tags.has(s)).map((s) => ({ tag: s, solved: tags.get(s) }));
      const solved = Math.max(0, ...matched.map((m) => m.solved));
      if (solved < model.topics.dsaMinSolved) continue;
      out.push({ code: t.code, source: "leetcode", score: round2(saturate(solved, model.topics.dsaK)), stale: dsa.status === "stale",
        evidence: { solved, tags: matched, note: "Problems solved with this LeetCode tag. Problems carry several tags." } });
    }
  }
  if (HAS_SCORE.has(github.status)) {
    const byArea = new Map();
    // Repositories arrive best first, so each area's first entry is its strongest.
    for (const r of github.repositories.filter((x) => x.evaluated))
      for (const a of r.areas) byArea.set(a, [...(byArea.get(a) || []), r]);
    for (const [code, repos] of [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ code, source: "github", score: repos[0].score, stale: github.status === "stale",
        evidence: { repositories: repos.slice(0, 5).map((r) => ({ name: r.repo.fullName, url: r.repo.url, score: r.score })),
          note: "Score of the strongest classified repository. Project evidence, not subject mastery." } });
    }
  }
  return out;
}

// ---- Whole student --------------------------------------------------------------------------
export function inputHash(input, model) {
  return createHash("sha256").update(JSON.stringify({ model: model.version, input })).digest("hex");
}

/**
 * Evaluates one student. input: {id, cgpa, consented, visibility, leetcode, github}
 * as returned by ranking.calculation_inputs(). Returns everything stored in
 * ranking.scores plus the topic rows.
 */
export function evaluateStudent(input, model, now = Date.now()) {
  const visibility = input.visibility || {};
  const consented = input.consented === true;
  const academic = academicScore(input.cgpa, model);
  const dsa = dsaScore(input.leetcode, consented && visibility.platforms !== false && input.leetcode?.visible !== false, model, now);
  const gh = githubScore(input.github, consented && visibility.platforms !== false && visibility.projects !== false && input.github?.visible !== false, model, now);
  const { repositories, ...github } = gh;
  const parts = { academic, dsa, github };
  const w = model.weights;
  const fresh = Object.values(parts).every((p) => p.status === "scored");
  const blockers = Object.entries(parts)
    .filter(([, p]) => p.status !== "scored")
    .map(([k, p]) => `${{ academic: "Academic", dsa: "DSA", github: "GitHub" }[k]}: ${p.reason || p.status}`);
  const developer = fresh
    ? component("scored", w.academic * academic.score + w.dsa * dsa.score + w.github * github.score, null, {
        weights: w,
        contributions: { academic: round2(w.academic * academic.score), dsa: round2(w.dsa * dsa.score), github: round2(w.github * github.score) },
        formula: `${w.academic} x Academic + ${w.dsa} x DSA + ${w.github} x GitHub`,
        note: "Provisional software-oriented score. Not an official measure of engineering ability and never a basis for automatic rejection.",
      })
    : component("pending", null, "Pending score: every component needs current evidence.", { blockers, weights: w });
  const coverage = round2(Object.entries(parts).reduce((s, [k, p]) => s + (HAS_SCORE.has(p.status) ? w[k] : 0), 0));
  const platformData = [dsa, github].filter((p) => HAS_SCORE.has(p.status)).length;
  const evidenceState = fresh ? "complete" : HAS_SCORE.has(academic.status) && platformData ? "partial" : "pending";
  const synced = [input.leetcode, input.github].filter((a) => a?.lastSyncedAt && a.state === "linked").map((a) => a.lastSyncedAt).sort();
  return {
    studentId: input.id,
    modelVersion: model.version,
    academic, dsa, github, developer,
    coverage,
    evidenceState,
    evidenceSyncedAt: synced[0] ?? null,
    topics: topicScores(dsa, input.leetcode, gh, model),
    inputHash: inputHash(input, model),
  };
}
