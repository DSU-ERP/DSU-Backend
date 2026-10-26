import { createPool } from "../src/integrations/supabase/db.js";
import { assertTestingTarget } from "../src/platform/testing-guard.js";

assertTestingTarget();
const env = { ...process.env, DATABASE_CA_PATH: process.env.TESTING_DATABASE_CA_PATH || process.env.DATABASE_CA_PATH, DATABASE_POOL_MAX: "1" };
const pool = createPool(process.env.TESTING_DATABASE_ADMIN_URL, env);
try {
  const { rows } = await pool.query("SELECT to_regclass('testing.environment_marker') AS marker, (SELECT count(*)::int FROM erp.students) AS student_count");
  const activity = await pool.query("SELECT state,wait_event_type,wait_event,left(query,80) AS query FROM pg_stat_activity WHERE application_name='dsu-backend' AND pid<>pg_backend_pid()");
  console.log(JSON.stringify({ ...rows[0], active_connections: activity.rows }));
} finally {
  await pool.end();
}
