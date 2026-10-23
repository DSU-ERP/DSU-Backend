import { PLATFORM_LABELS } from "./constants.js";

// Descriptive placement readiness. There is deliberately no numeric score:
// every item is a plain statement backed by a stored value, or a note that
// the information is missing or not shared. Absence of a platform is only
// ever "not provided", never evidence about ability.

const CODING = ["leetcode", "hackerrank", "huggingface", "kaggle"];
const ONBOARDING_LABELS = {
  identity: "Identity confirmation",
  visibility: "Visibility settings",
};
const PROVENANCE_LABELS = {
  institution_verified: "institution verified",
  platform_verified: "platform verified",
  student_submitted: "student submitted",
  ai_generated: "AI generated",
  unavailable: "unavailable",
};

const sectionLabel = (key) => ONBOARDING_LABELS[key] || PLATFORM_LABELS[key] || key;
const list = (values) =>
  values.length <= 1
    ? values.join("")
    : values.slice(0, -1).join(", ") + " and " + values.at(-1);

/**
 * input:
 *   academic: {cgpa, eligible} (official values only)
 *   onboarding: {complete, missing?}
 *   visibility: {platforms, projects, ...} as seen by the viewer
 *   accounts: normalized accounts ({platform, state, ownership, ...}); accounts
 *     hidden from the viewer are simply absent or carry no ownership
 *   repositories, featured: repositories and featured projects the viewer can see
 *   viewer: 'student' | 'officer'
 */
export function readinessNotes({
  academic = {},
  onboarding = {},
  visibility = {},
  accounts = [],
  repositories = [],
  featured = [],
  viewer = "student",
} = {}) {
  const items = [];
  const self = viewer === "student";
  const byPlatform = Object.fromEntries(accounts.map((a) => [a.platform, a]));

  // 1. Academic eligibility: official CGPA only.
  const hasCgpa = academic.cgpa !== null && academic.cgpa !== undefined && academic.cgpa !== "";
  items.push({
    key: "academic_eligibility",
    label: "Academic eligibility",
    state: !hasCgpa || academic.eligible == null ? "unavailable" : academic.eligible ? "met" : "missing",
    detail: !hasCgpa || academic.eligible == null
      ? "No official CGPA is on record, so placement eligibility cannot be confirmed yet. Eligibility is decided by official CGPA only."
      : academic.eligible
        ? "The official CGPA meets the institution placement rule (6.75 or above). Eligibility is decided by official CGPA only."
        : "The official CGPA is below the institution placement rule (6.75 or above). Eligibility is decided by official CGPA only.",
    provenance: hasCgpa ? "institution_verified" : "unavailable",
  });

  // 2. Profile completeness: skills onboarding.
  const missingSections = (onboarding.missing || []).map(sectionLabel);
  items.push({
    key: "profile_completeness",
    label: "Profile completeness",
    state: onboarding.complete ? "met" : "missing",
    detail: onboarding.complete
      ? "Skills onboarding is complete."
      : missingSections.length
        ? "Skills onboarding is not complete. Still to do: " + list(missingSections) + "."
        : "Skills onboarding is not complete.",
    provenance: "student_submitted",
  });

  // 3. Verified technical projects (GitHub, platform verified).
  const github = byPlatform.github;
  // ownership is null when the officer view hides platform details; repositories
  // themselves only exist for accounts the sync verified.
  const verifiedGithub = github?.state === "linked" && (github.ownership === "platform_verified" || github.ownership == null);
  const repoNames = new Set([
    ...repositories.map((r) => r.fullName || r.name),
    ...featured.map((f) => f.repo?.fullName || f.repo?.name),
  ].filter(Boolean));
  let projects;
  if (!self && visibility.projects === false)
    projects = { state: "unavailable", detail: "The student has chosen not to share projects.", provenance: "unavailable" };
  else if (!github || github.state !== "linked")
    projects = {
      state: "missing",
      detail: github?.state === "declared_none"
        ? "Not provided. The student does not use GitHub. This says nothing about ability."
        : "Not provided. No GitHub account is connected. This says nothing about ability.",
      provenance: "unavailable",
    };
  else if (!verifiedGithub)
    projects = { state: "unavailable", detail: "A GitHub link was given but has not been verified with GitHub.", provenance: "student_submitted" };
  else if (!repoNames.size)
    projects = { state: "missing", detail: "GitHub is verified, but no public repositories are on record yet.", provenance: "platform_verified" };
  else
    projects = {
      state: "met",
      detail: (repoNames.size === 1 ? "One public repository is" : `${repoNames.size} public repositories are`) +
        " verified through GitHub" + (featured.length ? ", including " + list(featured.map((f) => f.repo?.name).filter(Boolean)) + "." : "."),
      provenance: "platform_verified",
    };
  items.push({ key: "verified_projects", label: "Verified technical projects", ...projects });

  // 4. Coding platforms, each labelled with where its values come from.
  const present = CODING.filter((p) => byPlatform[p]?.state === "linked");
  const notProvided = CODING.filter((p) => byPlatform[p]?.state !== "linked");
  const platformsHidden = !self && visibility.platforms === false;
  const describe = (p) => {
    const ownership = byPlatform[p].ownership;
    return PLATFORM_LABELS[p] + (ownership ? " (" + (PROVENANCE_LABELS[ownership] || ownership) + ")" : "");
  };
  const provenances = new Set(present.map((p) => byPlatform[p].ownership).filter(Boolean));
  items.push({
    key: "coding_platforms",
    label: "Coding platforms",
    state: platformsHidden ? "unavailable" : present.length ? "met" : "missing",
    detail: platformsHidden
      ? "The student has chosen not to share platform details."
      : (present.length ? "Provided: " + list(present.map(describe)) + "." : "") +
        (present.length && notProvided.length ? " " : "") +
        (notProvided.length ? "Not provided: " + list(notProvided.map((p) => PLATFORM_LABELS[p])) +
          ". Absence of a platform is not evidence of skill level." : ""),
    provenance: platformsHidden ? "unavailable" : provenances.size === 1 ? [...provenances][0] : provenances.size ? "student_submitted" : "unavailable",
  });

  // 5. Missing profile information, gathered in one place.
  const gaps = [];
  if (!hasCgpa) gaps.push("official CGPA");
  if (!onboarding.complete) gaps.push(...(missingSections.length ? missingSections : ["skills onboarding"]));
  items.push({
    key: "missing_information",
    label: "Missing profile information",
    state: gaps.length ? "missing" : "met",
    detail: gaps.length
      ? "Not provided yet: " + list([...new Set(gaps)]) + "."
      : "No required profile information is missing.",
    provenance: gaps.length ? "unavailable" : "student_submitted",
  });

  return { status: "descriptive", items };
}
