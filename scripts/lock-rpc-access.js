// Run only AFTER deploying both new services. Dry-run by default.
import { createPool } from "../src/integrations/supabase/db.js";
const pool = createPool(process.env.DATABASE_ADMIN_URL);
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`REVOKE EXECUTE ON FUNCTION public.dsu_portal_read(text,jsonb), public.dsu_batch_read(text,jsonb),
    public.dsu_placement_read(text,jsonb), public.dsu_placement_mutate(text,jsonb,uuid),
    public.dsu_placement_imports(), public.dsu_friday_rename(uuid,text) FROM authenticated`);
  const apply = process.argv.includes("--apply");
  await client.query(apply ? "COMMIT" : "ROLLBACK");
  console.log(apply ? "Direct Data API access revoked; use the authenticated backend." : "Validated RPC cutover; no changes saved. Add --apply after both services are deployed.");
} catch (error) {
  if (client) await client.query("ROLLBACK");
  console.error("RPC cutover failed:", error.code || "CHECK_CONFIGURATION");
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
