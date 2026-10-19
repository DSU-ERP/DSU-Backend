import { buildApp } from "./app.js";
import { createPool } from "./integrations/supabase/db.js";
import { readEnv } from "./config/env.js";
import { schemaStatus } from "./platform/database/readiness.js";
import Redis from "ioredis";
let pool, redis, app;
try {
  const env = readEnv();
  pool = createPool(env.DATABASE_URL, env);
  if (env.RATE_LIMIT_MODE === "redis") {
    redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 250, 2000),
    });
    redis.on("error", () =>
      console.error(JSON.stringify({ event: "redis_unavailable" })),
    );
    await redis.connect();
    await redis.ping();
  }
  const { rows } = await pool.query(
    "SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
  );
  if (rows[0]?.name !== "dsu_api" || rows[0].rolsuper || rows[0].rolbypassrls)
    throw Error("Runtime must use the restricted dsu_api role");
  try {
    const schema = await schemaStatus(pool);
    if (!schema.ready)
      console.error(
        JSON.stringify({
          event: "database_update_pending",
          missing: schema.missing,
          action:
            "Run `npm run db:migrate` in DSU-Backend with the operator connection, then restart this server.",
        }),
      );
  } catch {
    console.error(JSON.stringify({ event: "database_schema_check_failed" }));
  }
  app = await buildApp({
    pool,
    redis,
    env,
    logger: {
      level: env.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-service-token",
      ],
    },
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    try {
      await app.close();
      if (redis) await redis.quit();
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  console.error(
    JSON.stringify({
      event: "startup_failed",
      code: error.code || "CONFIGURATION_OR_DATABASE_ERROR",
      // Credentials embedded in connection strings are removed before logging.
      message: String(error.message || "")
        .replace(/\/\/[^/\s@]*@/g, "//***@")
        .slice(0, 300),
    }),
  );
  if (app) await app.close();
  else if (pool) await pool.end();
  redis?.disconnect();
  process.exitCode = 1;
}
