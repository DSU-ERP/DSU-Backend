import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/platform/database/migrations.js";

export async function testDatabase() {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,aud text,role text,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}')");
  const operator = { query: (sql, values) => values ? db.query(sql, values) : db.exec(sql).then(results => results.at(-1)) };
  await migrate(operator);
  const runtime = {
    async query(sql, values) {
      let result;
      try { result = await db.query(sql, values); }
      catch (error) { console.error("Synthetic database query failed:", error.code, error.message); throw error; }
      if (sql.startsWith("BEGIN")) await db.query("SET LOCAL ROLE dsu_api");
      return result;
    }, release() {},
  };
  return { db, operator, pool: { query: (sql, values) => db.query(sql, values), connect: async () => runtime, end: async () => db.close() } };
}
