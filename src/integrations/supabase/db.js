import pg from "pg";
import { readFileSync } from "node:fs";

export function createPool(url, env = process.env) {
  if (!url) throw new Error("Database connection is not configured");
  // URL sslmode parameters can override pg's verified TLS configuration.
  const parsed = new URL(url);
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    parsed.searchParams.delete(key);
  const useTls = env.DATABASE_SSL !== "false";
  if (!useTls && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    throw new Error("TLS is required for remote databases");
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    ssl: useTls
      ? {
          rejectUnauthorized: true,
          ...(env.DATABASE_CA_PATH
            ? { ca: readFileSync(env.DATABASE_CA_PATH, "utf8") }
            : {}),
        }
      : false,
    max: 5,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    query_timeout: 20000,
    application_name: "dsu-api",
  });
  pool.on("error", (error) =>
    console.error(
      JSON.stringify({
        event: "idle_database_connection_error",
        code: error.code || "DATABASE_ERROR",
      }),
    ),
  );
  return pool;
}

export async function withActor(
  pool,
  actorId,
  fn,
  { repeatableRead = false } = {},
) {
  const client = await pool.connect();
  try {
    await client.query(
      repeatableRead ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
    );
    await client.query("SELECT set_config('app.user_id', $1, true)", [actorId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
