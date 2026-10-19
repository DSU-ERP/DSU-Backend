// Read-only report: which migrations are applied/pending, whether the runtime
// schema is ready, and row counts (never row contents) for ERP and legacy tables.
import { createPool } from "../src/integrations/supabase/db.js";
import { migrationFiles, checksumMatches } from "../src/platform/database/migrations.js";
import { schemaStatus } from "../src/platform/database/readiness.js";

const url = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_ADMIN_URL (.env.operator) or DATABASE_URL (.env) first.");
  process.exit(1);
}
const pool = createPool(url);
const count = async (relation) => {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${relation}`);
    return rows[0].n;
  } catch (error) {
    return error.code === "42P01" ? "missing" : `not readable (${error.code || "error"})`;
  }
};
try {
  const who = (await pool.query("SELECT current_user AS role")).rows[0].role;
  console.log(`Connected as ${who}\n`);
  const files = await migrationFiles();
  let applied = new Map();
  try {
    const { rows } = await pool.query("SELECT name,checksum FROM erp.schema_migrations");
    applied = new Map(rows.map((row) => [row.name, row.checksum]));
  } catch (error) {
    console.log(`Migration history not readable with this role (${error.code}). Use the operator connection for the full list.\n`);
  }
  if (applied.size) {
    console.log("Migrations:");
    for (const file of files) {
      const state = !applied.has(file.name)
        ? "PENDING"
        : checksumMatches(file.sql, applied.get(file.name))
          ? "applied"
          : "CHANGED AFTER APPLY";
      console.log(`  ${state.padEnd(20)} ${file.name}`);
    }
    const pending = files.filter((file) => !applied.has(file.name)).length;
    console.log(pending ? `\n${pending} pending. Run: npm run db:migrate\n` : "\nAll migrations applied.\n");
  }
  const schema = await schemaStatus(pool).catch((error) => ({ ready: false, missing: [`check failed (${error.code})`] }));
  console.log(schema.ready ? "Backend schema: ready" : `Backend schema: NOT ready, missing ${schema.missing.join(", ")}`);
  console.log("\nRow counts (ERP tables used by this app):");
  for (const table of ["erp.students", "erp.academics", "erp.contacts", "erp.memberships", "placement.officers", "student.profiles", "student.registration_drafts"])
    console.log(`  ${table.padEnd(30)} ${await count(table)}`);
  console.log("\nRow counts (legacy public tables, not used by this app):");
  const { rows: legacy } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name ~ '^(students?|student_.*)$' ORDER BY 1",
  );
  if (!legacy.length) console.log("  (none visible to this role)");
  for (const { table_name } of legacy)
    console.log(`  ${("public." + table_name).padEnd(30)} ${await count(`public."${table_name.replace(/"/g, '""')}"`)}`);
} catch (error) {
  console.error(`Status check failed: ${error.code || "CONNECT_FAILED"} ${String(error.message || "").replace(/\/\/[^/\s@]*@/g, "//***@").slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
