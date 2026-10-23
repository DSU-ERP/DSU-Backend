// Grounded AI profile summaries. The server builds a numbered evidence list
// from the canonical profile only; the model may only make claims that cite
// those ids, and anything uncited is dropped before it is stored.
// Inputs never include contact or family data, tokens or URLs.
import { createHash } from "node:crypto";
import { z } from "zod";
import { runStudent } from "../students/context.js";
import { httpError } from "../../platform/http/errors.js";
import { PLATFORM_LABELS } from "./constants.js";
import { getMyStudentProfile } from "./profile-service.js";

export const SUMMARY_KIND = "profile.summary";
export const SUMMARY_CACHE_HOURS = 24;
export const SUMMARIES_PER_HOUR = 3;

const MAX_VALUE = 400;
const clip = (value, n = MAX_VALUE) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
};
const present = (v) => v !== null && v !== undefined && v !== "";

// Student-submitted platform values. URLs are removed (certificate links can
// identify a person); only names and figures go to the model.
function submittedEntries(platform, submitted) {
  const out = [];
  if (!submitted || typeof submitted !== "object") return out;
  for (const [key, value] of Object.entries(submitted)) {
    if (!present(value)) continue;
    if (Array.isArray(value)) {
      const names = value
        .map((v) => (v && typeof v === "object" ? [v.name || v.title, v.stars ? `${v.stars} stars` : null].filter(Boolean).join(", ") : v))
        .filter((v) => typeof v === "string" && v.trim());
      if (names.length) out.push([key, names.slice(0, 20).join("; ")]);
    } else if (typeof value !== "object") out.push([key, String(value)]);
  }
  return out;
}

/**
 * Build the evidence list from the canonical profile (getMyStudentProfile
 * output) and the student's own skills and interests. Items the student has
 * hidden from officers (visibility) are left out so a shared summary can never
 * reveal them.
 */
export function buildEvidence(profile, details = {}) {
  const items = [];
  const add = (kind, label, value, provenance, platform) => {
    if (!present(value)) return;
    items.push({ id: "e" + (items.length + 1), kind, label, value: clip(value), provenance, ...(platform ? { platform } : {}) });
  };
  const a = profile.academic || {};
  add("academic", "Programme", [a.program, a.departmentName || a.department, a.semester && `semester ${a.semester}`, a.batch && `passing-out batch ${a.batch}`].filter(Boolean).join(", "), "institution_verified");
  if (present(a.cgpa)) {
    add("academic", "Official CGPA", a.cgpa + (a.categoryLabel ? ` (category: ${a.categoryLabel})` : ""), "institution_verified");
    add("academic", "Placement eligibility by official CGPA rule", a.eligible ? "Eligible" : "Not eligible", "institution_verified");
  }
  if (present(a.backlogs)) add("academic", "Current backlogs", String(a.backlogs), "institution_verified");
  const r = profile.ranking || {};
  if (present(r.batchRank))
    add("ranking", "Batch rank by official CGPA (dense rank)", `${r.batchRank} of ${r.batchSize}`, "institution_verified");
  if (present(r.categoryRank))
    add("ranking", "Category rank by official CGPA (dense rank)", `${r.categoryRank} of ${r.categorySize}`, "institution_verified");

  const vis = profile.visibility || {};
  const accounts = (profile.accounts || []).filter((x) => x.state === "linked" && x.visible !== false);
  if (vis.platforms !== false) {
    for (const account of accounts) {
      const name = PLATFORM_LABELS[account.platform] || account.platform;
      const ownership = account.ownership || "student_submitted";
      add("platform", `${name} account`, account.handle ? `Linked as ${account.handle}` : "Linked", ownership, account.platform);
      for (const m of account.metrics || [])
        add("metric", `${name}: ${m.label || m.metric}`, m.value, m.verification, account.platform);
      for (const [key, value] of submittedEntries(account.platform, account.submitted))
        add("submitted", `${name} (student submitted): ${key}`, value, "student_submitted", account.platform);
    }
  }
  const github = accounts.find((x) => x.platform === "github");
  if (github && vis.activity !== false)
    for (const m of profile.github?.activity || []) add("activity", `GitHub: ${m.label || m.metric}`, m.value, m.verification, "github");
  if (github && vis.projects !== false) {
    const repoProvenance = github.ownership === "platform_verified" ? "platform_verified" : "student_submitted";
    const describe = (repo) =>
      [repo.description, repo.primaryLanguage && `language ${repo.primaryLanguage}`, Number.isFinite(repo.stars) ? `${repo.stars} stars` : null,
        Array.isArray(repo.topics) && repo.topics.length ? `topics ${repo.topics.slice(0, 8).join(", ")}` : null,
        repo.hasReadme ? "has a README" : null].filter(Boolean).join("; ") || "No description";
    const featured = profile.github?.featured || [];
    const seen = new Set();
    for (const f of featured) {
      seen.add(f.repo?.fullName);
      add("project", `Featured project ${f.repo?.name} (${f.source === "github_pinned" ? "pinned on GitHub" : "selected by the student"})`, describe(f.repo || {}), repoProvenance, "github");
    }
    for (const repo of (profile.github?.repositories || []).filter((x) => !seen.has(x.fullName)).slice(0, 5))
      add("project", `Repository ${repo.name}`, describe(repo), repoProvenance, "github");
  }
  if (typeof details.skills === "string" && details.skills.trim())
    add("self", "Skills listed by the student", details.skills.trim(), "student_submitted");
  if (Array.isArray(details.interests) && details.interests.length)
    add("self", "Interests listed by the student", details.interests.filter((x) => typeof x === "string").slice(0, 20).join(", "), "student_submitted");
  return items;
}

/**
 * Evidence groups a summary depends on. Stored with the summary so
 * placement.skill_profile can withhold it from officers once any group is no
 * longer shared: "platforms:<platform>" (platforms toggle and that account),
 * "projects" and "activity" (their toggles and the GitHub account).
 * Academic, ranking and self-listed items are always shared and need no group.
 */
export function evidenceSources(evidence) {
  const sources = new Set();
  for (const item of evidence) {
    if (["platform", "metric", "submitted"].includes(item.kind)) sources.add(`platforms:${item.platform}`);
    else if (item.kind === "project") sources.add("projects");
    else if (item.kind === "activity") sources.add("activity");
  }
  return [...sources].sort();
}

export const evidenceHash = (evidence) =>
  createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

const cite = z.array(z.string().regex(/^e[0-9]{1,3}$/)).max(12);
const line = z.string().trim().min(1).max(400);
export const summarySchema = z
  .object({
    summary: z.object({ text: z.string().trim().min(1).max(1200), evidence: cite }).strict(),
    skills: z.array(z.object({ name: z.string().trim().min(1).max(80), evidence: cite }).strict()).max(12),
    projects: z.array(z.object({ name: z.string().trim().min(1).max(200), evidence: cite }).strict()).max(3),
    academicStrengths: z.array(z.object({ text: line, evidence: cite }).strict()).max(5),
    achievements: z.array(z.object({ text: line, evidence: cite }).strict()).max(6),
    developmentAreas: z.array(z.object({ text: line, evidence: cite }).strict()).max(5),
    potentialRoles: z
      .array(z.object({ role: z.string().trim().min(1).max(100), rationale: line, evidence: cite }).strict())
      .max(4),
  })
  .strict();

export const SUMMARY_TASK =
  "Write a short, factual placement profile summary for this student from the numbered evidence list only. " +
  "Rules: every claim must cite the ids of the evidence items that support it (for example [\"e1\",\"e4\"]); " +
  "a claim you cannot support with the listed evidence must be left out. Only state what the evidence supports. " +
  "Do not invent achievements, internships, certifications, employers, awards or projects. " +
  "Do not give scores, ratings, percentages of readiness or rankings beyond the official ranks provided. " +
  "Values marked student_submitted were entered by the student and are not verified; say so when you rely on them. " +
  "A missing platform or missing value is not evidence of low ability; do not treat absence as a weakness. " +
  "Potential roles are non-binding suggestions for the student to explore, never decisions or predictions. " +
  "Development areas must be constructive and grounded in the evidence. " +
  "Use plain sentences. Never use em dashes. Return only the requested JSON.";

const tidy = (text) => text.replace(/\s*[—–]\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
// Model text that presents itself as a score is not kept.
const scoreLike = /\b\d+(?:\.\d+)?\s*(?:\/|out of)\s*(?:5|10|100)\b|\b(?:readiness|employability|placement)\s+score\b/i;

/**
 * Keep only claims whose citations are non-empty and all known. Returns the
 * stored content shape. Throws AI_INVALID_RESPONSE when nothing grounded remains.
 */
export function groundSummary(output, evidence) {
  const known = new Set(evidence.map((e) => e.id));
  const grounded = (item) =>
    Array.isArray(item?.evidence) && item.evidence.length > 0 && item.evidence.every((id) => known.has(id));
  const keep = (list, fields) =>
    (list || [])
      .filter(grounded)
      .map((item) => {
        const out = { ...item, evidence: [...new Set(item.evidence)] };
        for (const f of fields) out[f] = tidy(out[f]);
        return out;
      })
      .filter((item) => !fields.some((f) => scoreLike.test(item[f])));
  const summary = grounded(output.summary) && !scoreLike.test(output.summary.text)
    ? { text: tidy(output.summary.text), evidence: [...new Set(output.summary.evidence)] }
    : null;
  const content = {
    summary,
    skills: keep(output.skills, ["name"]),
    projects: keep(output.projects, ["name"]),
    academicStrengths: keep(output.academicStrengths, ["text"]),
    achievements: keep(output.achievements, ["text"]),
    developmentAreas: keep(output.developmentAreas, ["text"]),
    potentialRoles: keep(output.potentialRoles, ["role", "rationale"]),
    rolesNote: "Potential roles are suggestions to explore, not placement decisions.",
  };
  const kept = Object.entries(content).filter(([k, v]) => k !== "rolesNote" && (Array.isArray(v) ? v.length : v)).length;
  if (!kept)
    throw httpError(502, "AI_INVALID_RESPONSE", "The AI response had no claims backed by your profile evidence. Please retry; nothing was saved.");
  return content;
}

export function shapeStoredSummary(row) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    model: row.model,
    content: row.content,
    evidence: row.evidence,
    reviewedAt: row.reviewedAt ?? null,
    hidden: row.hidden,
    provenance: "ai_generated",
  };
}
const RETURNING = `RETURNING id,created_at AS "createdAt",model,content,evidence,reviewed_at AS "reviewedAt",hidden`;

export function summaryModel(env = {}) {
  return env.STUDENT_AI_MODEL || env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash";
}

/** Generate (or reuse) a grounded summary for the acting student. */
export async function generateSummary({ pool, generate, env }, actor) {
  // A missing provider is a configuration problem, not an attempt.
  generate?.assertConfigured?.();
  const prepared = await runStudent(pool, actor, async (client, ctx) => {
    // Serialise generations per student so concurrent requests cannot all pass the limit.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["student.summary." + ctx.id]);
    const profile = await getMyStudentProfile(client, ctx);
    const { rows: own } = await client.query("SELECT details FROM student.profiles WHERE user_id=$1", [actor]);
    const evidence = buildEvidence(profile, own[0]?.details || {});
    const inputHash = evidenceHash(evidence);
    const { rows: latest } = await client.query(
      `SELECT id,created_at AS "createdAt",model,content,evidence,reviewed_at AS "reviewedAt",hidden,input_hash,
         created_at>now()-make_interval(hours=>$2) AS fresh
       FROM student.profile_summaries WHERE student_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [ctx.id, SUMMARY_CACHE_HOURS],
    );
    const last = latest[0];
    // Same evidence as the latest summary within 24 hours: reuse it, no AI call.
    if (last?.fresh && last.input_hash === inputHash)
      return { cached: shapeStoredSummary(last) };
    // The limit counts attempts, recorded here before the model is called, so
    // failed, invalid and concurrent generations all count.
    const { rows: recent } = await client.query(
      "SELECT count(*)::int AS n FROM student.profile_summary_attempts WHERE student_id=$1 AND created_at>now()-interval '1 hour'",
      [ctx.id],
    );
    if (recent[0].n >= SUMMARIES_PER_HOUR)
      throw httpError(429, "SUMMARY_LIMIT", "You can generate a new summary up to 3 times an hour. Please try again later.");
    await client.query("INSERT INTO student.profile_summary_attempts(student_id) VALUES($1)", [ctx.id]);
    return { evidence, inputHash, studentId: ctx.id };
  });
  if (prepared.cached) return { ...prepared.cached, cached: true };

  const { evidence, inputHash, studentId } = prepared;
  const output = await generate(
    actor,
    SUMMARY_KIND,
    SUMMARY_TASK,
    {
      evidence: evidence.map(({ id, label, value, provenance }) => ({ id, label, value, provenance })),
      provenanceMeaning: {
        institution_verified: "official university record",
        platform_verified: "read from the platform through a verified connection",
        student_submitted: "entered by the student, not verified",
      },
    },
    summarySchema,
  );
  const content = groundSummary(output, evidence);
  const row = await runStudent(pool, actor, async (client) =>
    (await client.query(
      `INSERT INTO student.profile_summaries(student_id,model,content,evidence,input_hash,sources) VALUES($1,$2,$3,$4,$5,$6) ${RETURNING}`,
      [studentId, summaryModel(env).slice(0, 100), JSON.stringify(content), JSON.stringify(evidence), inputHash, JSON.stringify(evidenceSources(evidence))],
    )).rows[0],
  );
  return { ...shapeStoredSummary(row), cached: false };
}

/** review: mark reviewed now. hide: set hidden. Owner only (RLS). */
export async function updateSummary(pool, actor, { action, id, hidden }) {
  return runStudent(pool, actor, async (client, ctx) => {
    const { rows } =
      action === "review"
        ? await client.query(`UPDATE student.profile_summaries SET reviewed_at=now() WHERE id=$1 AND student_id=$2 ${RETURNING}`, [id, ctx.id])
        : await client.query(`UPDATE student.profile_summaries SET hidden=$3 WHERE id=$1 AND student_id=$2 ${RETURNING}`, [id, ctx.id, hidden]);
    if (!rows[0]) throw httpError(404, "NOT_FOUND", "This summary is unavailable.");
    return shapeStoredSummary(rows[0]);
  });
}
