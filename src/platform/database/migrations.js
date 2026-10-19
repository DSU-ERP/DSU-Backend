import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
// Preserve the filenames/checksums already recorded in deployed databases.
const bootstrap = ["202610130001_erp.sql", "202610130002_operator_role.sql"];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// Windows checkouts (git autocrlf) turn LF into CRLF. A migration that differs
// only in line endings is the same migration, so either form is accepted.
export function checksumMatches(sql, recorded) {
  const lf = sql.replace(/\r\n/g, "\n");
  return [sql, lf, lf.replace(/\n/g, "\r\n")].some((text) => sha256(text) === recorded);
}
export function orderMigrations(names) {
  const files = names.filter((name) => name.endsWith(".sql"));
  for (const name of bootstrap)
    if (!files.includes(name))
      throw new Error(`Missing bootstrap migration: ${name}`);
  return [
    ...bootstrap,
    ...files.filter((name) => !bootstrap.includes(name)).sort(),
  ];
}
export async function migrationFiles(
  folder = new URL("../../../supabase/migrations/", import.meta.url),
) {
  const files = [];
  for (const name of orderMigrations(await readdir(folder))) {
    const sql = await readFile(new URL(name, folder), "utf8");
    files.push({ name, checksum: sha256(sql), sql });
  }
  return files;
}
export async function migrate(
  client,
  folder = new URL("../../../supabase/migrations/", import.meta.url),
  onApplied = () => {},
) {
  await client.query("BEGIN");
  try {
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
    for (const name of orderMigrations(await readdir(folder))) {
      const sql = await readFile(new URL(name, folder), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query(
        "SELECT checksum FROM erp.schema_migrations WHERE name=$1",
        [name],
      );
      if (previous.rows[0]) {
        if (!checksumMatches(sql, previous.rows[0].checksum))
          throw new Error(`Applied migration checksum changed: ${name}`);
        continue;
      }
      try {
        await client.query(sql);
      } catch (error) {
        error.migration = name;
        throw error;
      }
      await client.query(
        "INSERT INTO erp.schema_migrations(name,checksum) VALUES ($1,$2)",
        [name, checksum],
      );
      onApplied(name);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
