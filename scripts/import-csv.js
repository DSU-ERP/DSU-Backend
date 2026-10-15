import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createPool } from "../src/integrations/supabase/db.js";
import { importStudents } from "../src/modules/imports/importer.js";
import { processCsv } from "../src/modules/imports/csv.js";
const folder = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!folder) {
  console.error("Usage: npm run csv:import -- <directory> [--dry-run]");
  process.exit(1);
}
const pool = dryRun ? null : createPool(process.env.DATABASE_ADMIN_URL);
try {
  const files = (await readdir(folder))
    .filter((f) => /^20\d{2}_Batch\.csv$/i.test(f))
    .sort();
  if (!files.length) throw new Error("No supported batch files");
  for (const file of files) {
    const batch = basename(file).slice(0, 4);
    if (dryRun) {
      console.log(
        JSON.stringify({
          file,
          ...(await processCsv(createReadStream(join(folder, file)), {
            batch,
            validateOnly: true,
          })),
        }),
      );
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const summary = await importStudents(
        client,
        createReadStream(join(folder, file)),
        batch,
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ file, ...summary }));
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
} catch (e) {
  console.error(
    "Import failed; current file rolled back:",
    e.code ||
      (e.message?.toLowerCase().includes("timeout")
        ? "DATABASE_TIMEOUT"
        : "INVALID_FILE_OR_CONFIGURATION"),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
