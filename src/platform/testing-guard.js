import { databaseProjectRef, parseDatabaseUrl, projectRef, ALWAYS_PROTECTED_REFS } from "./devguard.js";

export const TESTING_PROJECT_REF = "bsiibnoqfuyxieogions";
export const TESTING_MARKER = "dsu-synthetic-placement-testing-v1";

/**
 * Refuse an operator action unless it is pointed at the explicitly-approved
 * synthetic-data project. This guard deliberately knows no production
 * connection string and never loads .env or .env.operator.
 */
export function testingTargetChecks(env = {}) {
  const reasons = [];
  const declaredRef = String(env.TESTING_SUPABASE_PROJECT_REF || "").toLowerCase();
  const apiRef = projectRef(env.TESTING_SUPABASE_URL);
  const db = parseDatabaseUrl(env.TESTING_DATABASE_ADMIN_URL);
  const dbRef = databaseProjectRef(db);

  if (env.DSU_ENVIRONMENT !== "testing") reasons.push("DSU_ENVIRONMENT must be testing");
  if (declaredRef !== TESTING_PROJECT_REF)
    reasons.push("TESTING_SUPABASE_PROJECT_REF does not match the approved testing project");
  if (apiRef !== TESTING_PROJECT_REF)
    reasons.push("TESTING_SUPABASE_URL does not match the approved testing project");
  if (dbRef !== TESTING_PROJECT_REF)
    reasons.push("TESTING_DATABASE_ADMIN_URL does not target the approved testing project");
  if ([...ALWAYS_PROTECTED_REFS].includes(apiRef) || [...ALWAYS_PROTECTED_REFS].includes(dbRef))
    reasons.push("A protected DSU project can never be used for synthetic-data import");

  for (const name of ["SUPABASE_URL", "DATABASE_URL", "DATABASE_ADMIN_URL"]) {
    const value = env[name];
    if (!value) continue;
    const ref = name === "SUPABASE_URL" ? projectRef(value) : databaseProjectRef(parseDatabaseUrl(value));
    if (ref && ref === TESTING_PROJECT_REF)
      reasons.push(`${name} must not be used by testing-only commands`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function assertTestingTarget(env = process.env) {
  const result = testingTargetChecks(env);
  if (!result.ok) throw new Error(`TESTING_TARGET_REFUSED: ${result.reasons.join("; ")}`);
}

export async function assertTestingMarker(client) {
  const { rows } = await client.query(
    "SELECT value FROM testing.environment_marker WHERE key='environment'",
  );
  if (rows.length !== 1 || rows[0].value !== TESTING_MARKER)
    throw new Error("TESTING_TARGET_REFUSED: testing environment marker is missing or invalid");
}
