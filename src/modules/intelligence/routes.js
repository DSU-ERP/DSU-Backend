import { registerStudentSkillRoutes } from "./student-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";

// Student Skills Intelligence: one canonical profile service, several
// authorized views. See docs/STUDENT-INTELLIGENCE.md.
// student-routes.js: onboarding, platform connections, featured projects, sync.
// profile-routes.js: canonical profile reads (student and officer), officer
// directory, overview charts, lookups and AI summaries.
export function registerIntelligenceRoutes(api, deps) {
  registerStudentSkillRoutes(api, deps);
  registerProfileRoutes(api, deps);
}
