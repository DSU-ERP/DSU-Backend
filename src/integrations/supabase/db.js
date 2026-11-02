import pg from "pg";
import { readFileSync } from "node:fs";

// Return SQL DATE values as their literal YYYY-MM-DD text. pg's default turns
// them into local-midnight Date objects, which shifts the day in non-UTC zones
// (e.g. IST) and made registration-deadline comparisons always false.
pg.types.setTypeParser(1082, (value) => value);

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
    max: Number(env.DATABASE_POOL_MAX || 5),
    connectionTimeoutMillis: Number(env.DATABASE_CONNECTION_TIMEOUT_MS || 5000),
    idleTimeoutMillis: 30000,
    statement_timeout: Number(env.DATABASE_STATEMENT_TIMEOUT_MS || 15000),
    query_timeout: Number(env.DATABASE_QUERY_TIMEOUT_MS || 20000),
    application_name: "dsu-backend",
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

/**
 * Checks out a client and keeps an error listener on it while it is in use.
 * pg-pool removes its own listener during checkout, so a connection reset
 * (read ECONNRESET from Supabase or the network) would otherwise be an
 * unhandled 'error' event and stop the whole server. A broken connection is
 * released with its error, which makes the pool discard it instead of reusing it.
 * fn receives the client and discard(error) to mark the connection unusable.
 */
export async function useClient(pool, fn) {
  const client = await pool.connect();
  let broken = null;
  const discard = (error) => {
    broken ??= error || new Error("Database connection discarded");
  };
  const onError = (error) => {
    discard(error);
    console.error(
      JSON.stringify({ event: "database_connection_error", code: error?.code || "DATABASE_ERROR" }),
    );
  };
  client.on?.("error", onError);
  try {
    return await fn(client, discard);
  } finally {
    client.removeListener?.("error", onError);
    client.release(broken ?? undefined);
  }
}

export async function withActor(
  pool,
  actorId,
  fn,
  { repeatableRead = false } = {},
) {
  return useClient(pool, async (client, discard) => {
    try {
      await client.query(
        repeatableRead ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
      );
      // Both settings belong to the same transaction. One statement avoids a
      // network round trip for every authenticated read/write without changing
      // row-security scope or persisting either setting on a pooled connection.
      await client.query(
        "SELECT set_config('app.user_id', $1, true), set_config('request.jwt.claims', $2, true)",
        [actorId, JSON.stringify({sub:actorId,role:'authenticated'})],
      );
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A rollback that cannot run (the connection is gone) must not hide the
      // original error, and that connection must never return to the pool.
      await client.query("ROLLBACK").catch(discard);
      throw error;
    }
  });
}
