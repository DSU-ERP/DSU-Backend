// Guards for operator scripts that must only ever touch an isolated development
// project (docs/STUDENT-INTELLIGENCE.md section 9). Pure functions so every
// refusal path is unit tested; the database check takes an injected query.
import pgConnectionString from "pg-connection-string";

export const ALWAYS_PROTECTED_REFS = Object.freeze(["idioblehzhaibtgotfjk"]);
export const ENVIRONMENT_MARKER = "isolated-development";
export const DEV_PREFIX = "DEV";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const POOLER_HOST = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;

/** Supabase project ref from https://<ref>.supabase.co (or null). */
export function projectRef(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]{20})\.supabase\.(co|in)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Parses a Postgres connection string the way pg does (pg-connection-string),
 * so percent-encoding and ?host=/?user= overrides cannot hide the real target.
 * Returns decoded, lowercased {user, host, database} or null.
 */
export function parseDatabaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    // Same TLS parameter stripping as createPool (and no certificate file reads).
    const url = new URL(value);
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
    const config = pgConnectionString.parse(url.toString());
    const host = String(config.host || "").trim().toLowerCase();
    if (!host) return null;
    return {
      user: String(config.user || "").toLowerCase(),
      host,
      database: String(config.database || "").toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** Lowercased, decoded database host (or null). */
export function databaseHost(value) {
  return parseDatabaseUrl(value)?.host ?? null;
}

/** Supabase project a parsed connection reaches: db.<ref>.supabase.co, or the pooler tenant in user "<role>.<ref>". */
export function databaseProjectRef(parsed) {
  if (!parsed) return null;
  const direct = parsed.host.match(DIRECT_HOST);
  if (direct) return direct[1];
  if (POOLER_HOST.test(parsed.host)) {
    const tenant = parsed.user.match(/\.([a-z0-9]{20})$/);
    return tenant ? tenant[1] : null;
  }
  return null;
}

/**
 * Checks that need no network. `known` holds values from the runtime/operator
 * env (SUPABASE_URL, DATABASE_URL, DATABASE_ADMIN_URL) that must never be the target.
 * Returns {ok, apply, reasons[]}.
 */
export function staticChecks(env = {}, argv = [], known = {}) {
  const reasons = [];
  const apply = argv.includes("--apply");
  const protectedRefs = new Set([
    ...ALWAYS_PROTECTED_REFS,
    ...String(env.DSU_PROTECTED_PROJECT_REFS || "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  ]);
  if (env.DSU_ENVIRONMENT !== "development") reasons.push("DSU_ENVIRONMENT must be development");
  const target = projectRef(env.DEV_SUPABASE_URL);
  if (!env.DEV_SUPABASE_URL || !target) reasons.push("DEV_SUPABASE_URL must be https://<project-ref>.supabase.co");
  else {
    if (protectedRefs.has(target)) reasons.push("DEV_SUPABASE_URL is a protected project");
    for (const name of ["SUPABASE_URL"]) {
      const ref = projectRef(known[name] ?? env[name]);
      if (ref && ref === target) reasons.push(`DEV_SUPABASE_URL is the same project as ${name}`);
    }
  }
  const dbUrl = env.DEV_DATABASE_ADMIN_URL;
  const db = parseDatabaseUrl(dbUrl);
  if (!dbUrl || !db) reasons.push("DEV_DATABASE_ADMIN_URL must be set");
  else {
    const dbRef = databaseProjectRef(db);
    // Decoded user, host and database: percent-encoding cannot hide a protected ref.
    if ([...protectedRefs].some((ref) => [db.user, db.host, db.database].some((part) => part.includes(ref))))
      reasons.push("DEV_DATABASE_ADMIN_URL refers to a protected project");
    for (const name of ["DATABASE_URL", "DATABASE_ADMIN_URL"]) {
      const other = parseDatabaseUrl(known[name] ?? env[name]);
      if (!other) continue;
      // A shared regional pooler host is only "the same" for the same tenant.
      const sameHost = POOLER_HOST.test(db.host) ? other.host === db.host && other.user === db.user : other.host === db.host;
      if (sameHost) reasons.push(`DEV_DATABASE_ADMIN_URL uses the same host as ${name}`);
      const otherRef = databaseProjectRef(other);
      if (otherRef && (otherRef === dbRef || otherRef === target)) reasons.push(`DEV_DATABASE_ADMIN_URL is the same project as ${name}`);
    }
    if (LOCAL_HOSTS.has(db.host)) {
      // A local database has no project ref; allowed only when explicitly flagged,
      // and still subject to the environment marker checks.
      if (env.DEV_ALLOW_LOCAL_DB !== "1") reasons.push("DEV_DATABASE_ADMIN_URL is a local database; set DEV_ALLOW_LOCAL_DB=1 to allow it");
    } else if (
      !target ||
      !(db.host === `db.${target}.supabase.co` || (POOLER_HOST.test(db.host) && db.user === `postgres.${target}`))
    )
      reasons.push(
        "DEV_DATABASE_ADMIN_URL must be db.<project-ref>.supabase.co, or a Supabase pooler with user postgres.<project-ref>, for the DEV_SUPABASE_URL project",
      );
  }
  if (apply && !env.DEV_SUPABASE_SERVICE_ROLE_KEY) reasons.push("DEV_SUPABASE_SERVICE_ROLE_KEY is required with --apply");
  return { ok: reasons.length === 0, apply, reasons };
}

/**
 * Database checks through an injected query(sql, values) -> {rows}. The marker
 * table is never created here; an operator creates it by hand in the isolated project.
 */
export async function databaseChecks(query) {
  const reasons = [];
  const present = (await query("SELECT to_regclass('erp.environment_marker') IS NOT NULL AS present")).rows[0]?.present;
  if (!present) reasons.push("erp.environment_marker is missing");
  else {
    const values = (await query("SELECT value FROM erp.environment_marker")).rows.map((r) => r.value);
    if (values.length !== 1 || values[0] !== ENVIRONMENT_MARKER) reasons.push(`erp.environment_marker must be '${ENVIRONMENT_MARKER}'`);
  }
  const real = Number(
    (await query("SELECT count(*)::int AS n FROM erp.students WHERE enrollment_no NOT LIKE $1", [DEV_PREFIX + "%"])).rows[0]?.n ?? 1,
  );
  if (real > 0) reasons.push("erp.students contains records outside the synthetic DEV prefix");
  return { ok: reasons.length === 0, reasons };
}

/**
 * Writes the synthetic student in one transaction. The Auth user is created
 * only after the student rows are in place (so a failing insert creates no
 * Auth user), and it is deleted again if anything after its creation fails,
 * so no orphaned Auth account is ever left behind.
 * client: pg client; createUser() -> {id}; deleteUser(id); rows: insert callbacks.
 */
export async function provisionInTransaction(client, { createUser, deleteUser, insertStudent, insertMembership }) {
  let userId = null;
  await client.query("BEGIN");
  try {
    await insertStudent(client);
    userId = (await createUser()).id;
    await insertMembership(client, userId);
    await client.query("COMMIT");
    return userId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (userId) await deleteUser(userId).catch(() => {});
    throw error;
  }
}
