import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createPool } from "../src/integrations/supabase/db.js";
const pool = createPool(process.env.DATABASE_ADMIN_URL);
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('erp.migrations'))",
  );
  await client.query("CREATE SCHEMA IF NOT EXISTS erp");
  await client.query(
    "CREATE TABLE IF NOT EXISTS erp.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())",
  );
  await client.query(
    "REVOKE ALL ON erp.schema_migrations FROM PUBLIC, anon, authenticated",
  );
  const folder = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(folder))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new URL(name, folder), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previous = await client.query(
      "SELECT checksum FROM erp.schema_migrations WHERE name=$1",
      [name],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].checksum !== checksum)
        throw new Error("Applied migration checksum changed");
      continue;
    }
    await client.query(sql);
    await client.query(
      "INSERT INTO erp.schema_migrations(name,checksum) VALUES ($1,$2)",
      [name, checksum],
    );
    console.log(`Applied ${name}`);
  }
  await client.query("COMMIT");
} catch (e) {
  if (client) await client.query("ROLLBACK");
  console.error("Migration failed:", e.code || "CHECK_MIGRATION");
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
