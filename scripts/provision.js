// Run locally with owner credentials after migrations; never deploy owner URL.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createPool } from "../src/integrations/supabase/db.js";
const pool = createPool(process.env.DATABASE_ADMIN_URL);
try {
  const password = randomBytes(36).toString("base64url");
  const sql = await pool.query(
    "SELECT format('ALTER ROLE dsu_api LOGIN PASSWORD %L', $1::text) AS statement",
    [password],
  );
  await pool.query(sql.rows[0].statement);
  const url = new URL(process.env.DATABASE_ADMIN_URL);
  const suffix = decodeURIComponent(url.username).split(".").slice(1).join(".");
  url.username = `dsu_api${suffix ? "." + suffix : ""}`;
  url.password = password;
  let env = await readFile(".env", "utf8");
  env = env.replace(/^DATABASE_URL=.*\r?\n?/m, "");
  await writeFile(".env", `${env.trim()}\nDATABASE_URL=${url}\n`, {
    mode: 0o600,
  });
  console.log(
    "Restricted runtime login provisioned. DATABASE_URL saved to ignored .env.",
  );
} catch (e) {
  console.error("Provisioning failed:", e.code || "PROVISION_FAILED");
  process.exitCode = 1;
} finally {
  await pool.end();
}
