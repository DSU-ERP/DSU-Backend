// Drive comparison ("Compare my profile with this JD"): the job description is
// built on the server from the official drive record, never from client text.
const text = (value) =>
  value === null || value === undefined ? "" : String(value).trim();
const EMPLOYMENT = {
  "full-time": "Full-time",
  internship: "Internship",
  "internship-ppo": "Internship with pre-placement offer",
  contract: "Contract",
};

export function driveJobDescription(drive) {
  const lines = [];
  const add = (label, value) => {
    const line = Array.isArray(value)
      ? value.map(text).filter(Boolean).join(", ")
      : text(value);
    if (line) lines.push(`${label}: ${line}`);
  };
  add("Company", drive.company);
  add("Role", drive.title);
  add("Job category", drive.job_category);
  add("Employment type", EMPLOYMENT[drive.employment_type] || drive.employment_type);
  add("Package (LPA)", drive.package_lpa);
  add("Location", drive.location);
  add("Openings", drive.openings);
  add("Drive date", drive.drive_date);
  add("Registration deadline", drive.registration_deadline);
  add("Drive status", drive.status);
  add("Minimum CGPA", drive.min_cgpa);
  add("Maximum current backlogs", drive.max_backlogs);
  add("Minimum attendance (%)", drive.min_attendance);
  add(
    "Permitted branches",
    Array.isArray(drive.branches) && drive.branches.length
      ? drive.branches
      : "All branches",
  );
  add("Required skills", drive.skills);
  if (Array.isArray(drive.rounds) && drive.rounds.length)
    add("Selection rounds (in order)", drive.rounds.map(text).filter(Boolean).join(" → "));
  add("Required documents", drive.required_documents);
  add("Job description", drive.description);
  return lines.join("\n");
}

export const driveTitle = (drive) =>
  `Eligibility · ${text(drive.company) || "Placement drive"}`.slice(0, 120);

export const driveResearchQuery = (drive) =>
  `${text(drive.company)} ${text(drive.title)} campus recruitment process interview rounds`
    .replace(/\s+/g, " ")
    .trim();

export function officialEligibilityText(eligibility) {
  return eligibility.eligible
    ? "You meet this drive's published criteria."
    : `Not eligible under the published criteria: ${eligibility.gaps.join(" ")}`;
}

/** Asked instead of an analysis when no resume is available. */
export function resumeRequest(drive, eligibility) {
  return [
    `## Comparing with ${text(drive.company)} · ${text(drive.title)}`,
    "I can't compare your profile with this drive yet because there is no resume in your workspace or in this conversation. I won't analyse details I don't have.",
    "**To continue:**",
    // The header button is shown for every drive comparison, also when reopened.
    "1. Upload your resume (PDF, DOCX or TXT) or paste its text with **Add or edit resume** at the top of this chat.",
    "2. Send your request again. Each requirement will then be compared with your resume evidence.",
    `**Official eligibility (university rules):** ${officialEligibilityText(eligibility)}`,
  ].join("\n\n");
}
