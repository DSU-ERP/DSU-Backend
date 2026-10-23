// Canonical student skills profile. One student identity (erp.students.id),
// several authorized views. Every function takes a pg client that is already
// inside withActor(); callers own the transaction.
//
// Field names are shared between the student view and the officer view so the
// web can render both with the same components:
//   academic (student) == core (officer) for identity and official academics,
//   ranking, accounts[], featured[], repositories[], summary.
import { databaseError } from "../../platform/http/errors.js";
import { DEFAULT_VISIBILITY, METRIC_LABELS, PLATFORMS, onboardingStatus } from "./constants.js";
import { readinessNotes } from "./readiness-notes.js";

export const PROVENANCE_LEGEND = Object.freeze({
  institution_verified: "Official record held by the university (ERP).",
  platform_verified: "Read from the platform itself through a verified connection.",
  student_submitted: "Entered by the student and not verified by the platform.",
  ai_generated: "Written by AI from the evidence listed with it. Review before relying on it.",
  unavailable: "Not available or not shared.",
});

// Readable fallback for metric keys the sync code adds later.
export function metricLabel(metric) {
  if (METRIC_LABELS[metric]) return METRIC_LABELS[metric];
  const text = String(metric).replace(/[._]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const isActivity = (metric) => /^(activity|contributions)\./.test(metric);

const RANK_KEYS = ["batchRank", "categoryRank", "batchSize", "categorySize"];
export function normalizeRanking(raw) {
  const ranking = Object.fromEntries(RANK_KEYS.map((k) => [k, raw?.[k] ?? null]));
  return { ...ranking, scope: "batch" };
}

export function normalizeVisibility(stored) {
  const value = stored && typeof stored === "object" ? stored : {};
  // Same rule as placement.skill_profile: once stored, only an explicit true shows.
  return Object.fromEntries(
    Object.keys(DEFAULT_VISIBILITY).map((k) => [k, k in value ? value[k] === true : DEFAULT_VISIBILITY[k]]),
  );
}

const withMetricLabels = (metrics) =>
  (metrics || []).map((m) => ({
    metric: m.metric,
    label: metricLabel(m.metric),
    value: m.value,
    verification: m.verification,
    method: m.method,
    collectedAt: m.collectedAt ?? null,
    note: m.note ?? null,
  }));

// The officer function omits details for hidden or unlinked accounts; keep the
// same keys everywhere so a component never has to guess.
function normalizeAccount(a) {
  return {
    platform: a.platform,
    state: a.state,
    handle: a.handle ?? null,
    profileUrl: a.profileUrl ?? null,
    authMethod: a.authMethod ?? null,
    ownership: a.ownership ?? null,
    visible: a.visible ?? true,
    syncStatus: a.syncStatus ?? null,
    syncError: a.syncError ?? null,
    lastSyncedAt: a.lastSyncedAt ?? null,
    submitted: a.submitted ?? {},
    metrics: withMetricLabels(a.metrics),
  };
}

const sortAccounts = (accounts) =>
  [...accounts].sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));

function shapeSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.createdAt ?? null,
    model: row.model ?? null,
    content: row.content ?? {},
    evidence: row.evidence ?? [],
    reviewedAt: row.reviewedAt ?? null,
    ...(row.hidden !== undefined ? { hidden: row.hidden } : {}),
    provenance: "ai_generated",
  };
}

async function query(client, sql, values) {
  try {
    return (await client.query(sql, values)).rows;
  } catch (error) {
    throw databaseError(error);
  }
}

// Repository card: same keys as placement.repo_card().
const REPO_CARD = `jsonb_build_object('name',r.name,'fullName',r.full_name,'url',r.url,'description',r.description,
  'primaryLanguage',r.primary_language,'stars',r.stars,'pushedAt',r.pushed_at,'hasReadme',r.has_readme)`;

/**
 * Official ranks for one student. Students get their own position through
 * student.my_ranking(); officers through placement.student_core(). Both read
 * erp.cgpa_ranks, so the numbers are identical.
 */
export async function getStudentRanking(client, studentId) {
  const [{ me }] = await query(client, "SELECT erp.actor_student() AS me");
  if (me && me === studentId) {
    const [{ r }] = await query(client, "SELECT student.my_ranking() AS r");
    return normalizeRanking(r);
  }
  const [{ r }] = await query(client, "SELECT placement.student_core($1::uuid) AS r", [studentId]);
  return normalizeRanking(r?.ranking);
}

// Official academics from erp only (never student.profiles.details).
async function officialAcademic(client, ctx) {
  const [rule] = await query(
    client,
    `SELECT erp.cgpa_category($1::numeric) AS category,
      (SELECT x->>'name' FROM jsonb_array_elements(erp.cgpa_rules()) x WHERE x->>'id'=erp.cgpa_category($1::numeric)) AS label,
      erp.placement_eligible($1::numeric) AS eligible`,
    [ctx.cgpa ?? null],
  );
  return {
    id: ctx.id,
    name: ctx.full_name,
    usn: ctx.enrollment_no,
    department: ctx.department_short_name ?? null,
    departmentName: ctx.department_name ?? null,
    program: ctx.course_name ?? null,
    batch: ctx.source_batch ?? null,
    semester: ctx.current_semester ?? null,
    cgpa: ctx.cgpa ?? null,
    sgpa: ctx.sgpa ?? null,
    attendance: ctx.attendance ?? null,
    backlogs: ctx.current_backlog ?? null,
    category: rule.category ?? null,
    categoryLabel: rule.label ?? null,
    eligible: rule.eligible ?? null,
    provenance: "institution_verified",
  };
}

/**
 * The student's own canonical profile. ctx is the studentContext() row.
 * Everything the student owns is shown, including items hidden from officers.
 */
export async function getMyStudentProfile(client, ctx) {
  const id = ctx.id;
  const academic = await officialAcademic(client, ctx);
  const [{ r: rawRanking }] = await query(client, "SELECT student.my_ranking() AS r");
  const ranking = normalizeRanking(rawRanking);

  const [profileRow] = await query(
    client,
    `SELECT onboarding_version,onboarding_completed_at,identity_confirmed_at,visibility_saved_at,consent_version,
      consented_at,visibility,revision FROM student.skill_profiles WHERE student_id=$1`,
    [id],
  );
  // Credentials are never selected; only public account fields.
  const accountRows = await query(
    client,
    `SELECT a.id,a.platform,a.state,jsonb_build_object('platform',a.platform,'state',a.state,'handle',a.handle,
        'profileUrl',a.profile_url,'authMethod',a.auth_method,'ownership',a.ownership,'visible',a.visible,
        'syncStatus',a.sync_status,'syncError',a.sync_error,'lastSyncedAt',a.last_synced_at,'submitted',a.submitted,
        'metrics',coalesce((SELECT jsonb_agg(jsonb_build_object('metric',m.metric,'value',m.value,'verification',m.verification,
            'method',m.method,'collectedAt',m.collected_at,'note',m.note) ORDER BY m.metric)
          FROM student.platform_metrics m WHERE m.account_id=a.id),'[]'::jsonb)) AS account
     FROM student.platform_accounts a WHERE a.student_id=$1`,
    [id],
  );
  const accounts = sortAccounts(
    accountRows.map((row) => {
      const account = normalizeAccount(row.account);
      account.metrics = account.metrics.filter((m) => !isActivity(m.metric));
      return account;
    }),
  );
  const githubRow = accountRows.find((row) => row.platform === "github" && row.state === "linked");
  const activity = githubRow
    ? withMetricLabels(githubRow.account.metrics.filter((m) => isActivity(m.metric)))
    : [];

  let repositories = [], featured = [], pinned = [];
  if (githubRow) {
    repositories = (await query(
      client,
      `SELECT ${REPO_CARD}||jsonb_build_object('repoId',r.repo_id::text,'forks',r.forks,'topics',r.topics,'license',r.license,
          'homepage',r.homepage,'isFork',r.is_fork,'isArchived',r.is_archived,'pinned',r.pinned,'pinOrder',r.pin_order,
          'recommendationScore',r.recommendation_score,'recommendationReasons',r.recommendation_reasons,
          'additions52w',r.additions_52w) AS repo
       FROM student.github_repositories r WHERE r.account_id=$1
       ORDER BY r.recommendation_score DESC NULLS LAST,r.stars DESC,r.repo_id LIMIT 30`,
      [githubRow.id],
    )).map((row) => row.repo);
    pinned = (await query(
      client,
      `SELECT ${REPO_CARD}||jsonb_build_object('repoId',r.repo_id::text,'pinOrder',r.pin_order) AS repo
       FROM student.github_repositories r WHERE r.account_id=$1 AND r.pinned ORDER BY r.pin_order NULLS LAST,r.repo_id`,
      [githubRow.id],
    )).map((row) => row.repo);
    // Same selection as placement.skill_profile: pinned first, then student
    // selected, without duplicates, at most 3.
    featured = (await query(
      client,
      `WITH candidates AS(
         SELECT r AS repo,r.repo_id,'github_pinned'::text AS source,0 AS grp,r.pin_order AS ord
           FROM student.github_repositories r WHERE r.account_id=$1 AND r.pinned
         UNION ALL
         SELECT r,r.repo_id,'student_selected',1,fp.position
           FROM student.featured_projects fp JOIN student.github_repositories r ON r.account_id=fp.account_id AND r.repo_id=fp.repo_id
           WHERE fp.student_id=$2 AND r.account_id=$1),
       dedup AS(SELECT DISTINCT ON(c.repo_id) c.* FROM candidates c ORDER BY c.repo_id,c.grp,c.ord NULLS LAST),
       top3 AS(SELECT d.*,row_number() OVER(ORDER BY d.grp,d.ord NULLS LAST,d.repo_id) AS pos FROM dedup d ORDER BY pos LIMIT 3)
       SELECT jsonb_build_object('position',t.pos,'source',t.source,'repo',
         jsonb_build_object('name',(t.repo).name,'fullName',(t.repo).full_name,'url',(t.repo).url,'description',(t.repo).description,
           'primaryLanguage',(t.repo).primary_language,'stars',(t.repo).stars,'pushedAt',(t.repo).pushed_at,'hasReadme',(t.repo).has_readme,
           'repoId',t.repo_id::text)) AS item
       FROM top3 t ORDER BY t.pos`,
      [githubRow.id, id],
    )).map((row) => row.item);
  }

  const [summaryRow] = await query(
    client,
    `SELECT jsonb_build_object('id',x.id,'createdAt',x.created_at,'model',x.model,'content',x.content,'evidence',x.evidence,
       'reviewedAt',x.reviewed_at,'hidden',x.hidden) AS s
     FROM student.profile_summaries x WHERE x.student_id=$1 ORDER BY x.created_at DESC,x.id DESC LIMIT 1`,
    [id],
  );

  const onboarding = onboardingStatus(profileRow || null, accountRows.map((row) => row.account));
  const visibility = normalizeVisibility(profileRow?.visibility);
  return {
    academic,
    ranking,
    onboarding,
    visibility,
    accounts,
    github: { repositories, featured, pinned, activity },
    summary: shapeSummary(summaryRow?.s),
    readiness: readinessNotes({ academic, onboarding, visibility, accounts, repositories, featured, viewer: "student" }),
    revision: profileRow?.revision ?? 0,
  };
}

/**
 * Officer (or F.R.I.D.A.Y.) view of one student. Access is enforced by the SQL
 * functions (placement.assert_officer); purpose 'ai' strips URLs that could
 * identify private certificates or repositories. No contact or family data is
 * ever read here.
 */
export async function getAuthorizedStudentProfile(client, studentId, purpose = "officer") {
  const [{ core }] = await query(client, "SELECT placement.student_core($1::uuid) AS core", [studentId]);
  const [{ skills: raw }] = await query(client, "SELECT placement.skill_profile($1::uuid,$2::text) AS skills", [studentId, purpose]);
  const ranking = normalizeRanking(core.ranking);
  // summaryWithheld: the latest summary used evidence the student no longer shares
  // (visibility, a hidden account or a disconnected platform), so the SQL withheld it.
  const { summary: rawSummary, summaryWithheld, ...rest } = raw;
  const skills = {
    visibility: rest.visibility,
    onboarding: rest.onboarding,
    accounts: sortAccounts((rest.accounts || []).map(normalizeAccount)),
    featured: rest.featured || [],
    repositories: rest.repositories || [],
    activity: withMetricLabels(rest.activity),
  };
  const shapedCore = { ...core, ranking };
  return {
    core: shapedCore,
    ranking,
    skills,
    summary: shapeSummary(rawSummary),
    summaryWithheld: summaryWithheld === true,
    readiness: readinessNotes({
      academic: { cgpa: core.cgpa, eligible: core.eligible },
      onboarding: skills.onboarding,
      visibility: skills.visibility,
      accounts: skills.accounts,
      repositories: skills.repositories,
      featured: skills.featured,
      viewer: "officer",
    }),
    provenance: PROVENANCE_LEGEND,
    purpose,
  };
}

// Officer reads backed by one SQL function each. q is a validated flat object.
const OFFICER_RPCS = new Set([
  "ranked_students",
  "category_cards",
  "overview_charts",
  "lookup_students",
  "skill_students",
]);
export async function officerRead(client, fn, q = {}) {
  if (!OFFICER_RPCS.has(fn)) throw new Error("Unknown officer read");
  const [{ result }] = await query(client, `SELECT placement.${fn}($1::jsonb) AS result`, [JSON.stringify(q)]);
  return result;
}
