// Shared definitions for the student skills intelligence module. Pure data and
// pure functions only, so every route, the worker and the tests agree.

export const PLATFORMS = Object.freeze([
  "github",
  "leetcode",
  "hackerrank",
  "linkedin",
  "huggingface",
  "kaggle",
]);

export const PLATFORM_LABELS = Object.freeze({
  github: "GitHub",
  leetcode: "LeetCode",
  hackerrank: "HackerRank",
  linkedin: "LinkedIn",
  huggingface: "Hugging Face",
  kaggle: "Kaggle",
});

// Where a value came from. Never present one kind as another.
export const PROVENANCE = Object.freeze([
  "institution_verified",
  "platform_verified",
  "student_submitted",
  "ai_generated",
  "unavailable",
]);

export const SYNC_STATUSES = Object.freeze([
  "not_applicable",
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "unavailable",
]);

// Version of the skills onboarding requirements. Raising it sends every
// student back through onboarding; keep it equal to
// student.onboarding_current_version() in SQL.
export const ONBOARDING_VERSION = 2;
export const REQUIRED_PLATFORMS = Object.freeze([
  "github",
  "leetcode",
  "linkedin",
]);
export const OPTIONAL_PLATFORMS = Object.freeze(["hackerrank", "huggingface", "kaggle"]);

export const DEFAULT_VISIBILITY = Object.freeze({
  platforms: true,
  projects: true,
  activity: true,
  summary: true,
});

/**
 * Which onboarding sections are satisfied, from stored rows only.
 * profile: student.skill_profiles row or null.
 * accounts: student.platform_accounts rows for the student.
 * A platform section is satisfied by a linked account or an explicit
 * "I do not use this platform" declaration. Sync results never matter here,
 * so a provider outage cannot undo completed onboarding.
 */
export function onboardingSections(profile, accounts) {
  const state = Object.fromEntries(
    (accounts || []).map((a) => [a.platform, a.state]),
  );
  const answered = (p) =>
    state[p] === "linked" || state[p] === "declared_none";
  const sections = {
    identity: Boolean(profile?.identity_confirmed_at),
    // Saved explicitly by the student; defaults alone do not count.
    visibility: Boolean(profile?.visibility_saved_at),
  };
  for (const p of PLATFORMS) sections[p] = answered(p);
  const missing = ["identity", ...REQUIRED_PLATFORMS, "visibility"].filter(
    (key) => key !== "identity" && key !== "visibility"
      ? state[key] !== "linked"
      : !sections[key],
  );
  return { sections, missing };
}

export function onboardingStatus(profile, accounts) {
  const { sections, missing } = onboardingSections(profile, accounts);
  const version = profile?.onboarding_version ?? 0;
  return {
    version,
    currentVersion: ONBOARDING_VERSION,
    complete: version >= ONBOARDING_VERSION && missing.length === 0,
    completedAt: profile?.onboarding_completed_at ?? null,
    identityConfirmedAt: profile?.identity_confirmed_at ?? null,
    consentedAt: profile?.consented_at ?? null,
    sections,
    missing,
  };
}

// Human labels for stored metric keys (shared by the sync worker and the profile service).
export const METRIC_LABELS = Object.freeze({
  "repos.public": "Public repositories",
  "repos.original": "Original public repositories",
  "languages.top": "Most-used languages (repository share)",
  "contributions.total_12m": "Contributions (last 12 months)",
  "contributions.commits_12m": "Commits (last 12 months)",
  "contributions.private_12m": "Private contributions (last 12 months)",
  "contributions.lines_added_52w": "Lines added (last 52 weeks)",
  "activity.current_streak": "Current contribution streak (days)",
  "activity.longest_streak": "Longest contribution streak (days)",
  "activity.active_days": "Active days (last 12 months)",
  "activity.calendar": "Contribution calendar",
  "models.count": "Models",
  "datasets.count": "Datasets",
  "spaces.count": "Spaces",
  "models.top": "Top models",
  "datasets.top": "Top datasets",
  "spaces.top": "Top spaces",
  "problems.solved": "Problems solved",
  "problems.easy": "Easy problems solved",
  "problems.medium": "Medium problems solved",
  "problems.hard": "Hard problems solved",
  "contest.rating": "Contest rating",
  "contest.attended": "Contests attended",
  "topics.solved": "Problems solved by topic tag",
});

