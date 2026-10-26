import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/integrations/supabase/db.js";
import { migrate } from "../src/platform/database/migrations.js";
import { assertTestingMarker, assertTestingTarget } from "../src/platform/testing-guard.js";

assertTestingTarget();
const env = {
  ...process.env,
  DATABASE_CA_PATH: process.env.TESTING_DATABASE_CA_PATH || process.env.DATABASE_CA_PATH,
  DATABASE_POOL_MAX: "1",
};
const pool = createPool(process.env.TESTING_DATABASE_ADMIN_URL, env);
const file = new URL("../supabase/testing-migrations/001_synthetic_student_placement_import.sql", import.meta.url);
const name = fileURLToPath(file).split(/[\\/]/).pop();
const sql = await readFile(file, "utf8");
const checksum = createHash("sha256").update(sql).digest("hex");
let client;
try {
  client = await pool.connect();
  await migrate(client);
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('testing.synthetic-migrations'))");
  // The testing schema must not be coupled to erp.schema_migrations, which is
  // shared by normal application migrations.
  await client.query("CREATE SCHEMA IF NOT EXISTS testing");
  await client.query("CREATE TABLE IF NOT EXISTS testing.schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const prior = await client.query("SELECT checksum FROM testing.schema_migrations WHERE name=$1", [name]);
  if (prior.rows[0]?.checksum && prior.rows[0].checksum !== checksum)
    throw new Error(`Testing migration checksum changed: ${name}`);
  if (!prior.rows[0]) {
    await client.query(sql);
    await client.query("INSERT INTO testing.schema_migrations(name,checksum) VALUES($1,$2)", [name, checksum]);
    console.log(`Applied testing migration ${name}`);
  } else console.log("Testing schema is already up to date.");
  await assertTestingMarker(client);
  await client.query("COMMIT");
  console.log("Testing database is ready for synthetic data import.");
} catch (error) {
  await client?.query("ROLLBACK").catch(() => {});
  console.error(`Testing migration failed: ${error.code || error.message}`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
