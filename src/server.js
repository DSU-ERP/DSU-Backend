import { buildApp } from "./app.js";
import { createPool } from "./integrations/supabase/db.js";
const env = process.env;
for (const key of [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SERVICE_TOKEN",
])
  if (!env[key]) throw new Error(`Missing ${key}`);
const pool = createPool(env.DATABASE_URL);
try {
  const { rows } = await pool.query(
    "SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
  );
  if (rows[0]?.name !== "dsu_api" || rows[0].rolsuper || rows[0].rolbypassrls)
    throw new Error("Runtime must use the restricted dsu_api database role");
  const app = await buildApp({ pool });
  process.on("SIGTERM", () => void app.close());
  process.on("SIGINT", () => void app.close());
  await app.listen({ port: Number(env.PORT || 4001), host: "0.0.0.0" });
} catch (e) {
  console.error(
    JSON.stringify({
      event: "startup_failed",
      code: e.code || "CONFIGURATION_OR_DATABASE_ERROR",
    }),
  );
  await pool.end();
  process.exitCode = 1;
}
