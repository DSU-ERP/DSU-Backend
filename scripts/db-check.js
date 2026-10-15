import { createPool } from "../src/integrations/supabase/db.js";
const pool = createPool(
  process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
);
try {
  const { rows } = await pool.query(
    "SELECT current_database() AS database, current_user AS role",
  );
  const tables = await pool.query(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public','erp') ORDER BY 1,2",
  );
  console.log(
    JSON.stringify({ connected: true, ...rows[0], tables: tables.rows }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      connected: false,
      code: e.code || "CONNECT_FAILED",
      reason:
        e.code === "ENETUNREACH"
          ? "IPv6 unavailable; supply the Supabase session-pooler URL"
          : "Check network, database credentials, and trusted CA certificate",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
