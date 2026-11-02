// Adds or removes an account on the dedicated Admin portal list (ops.admins).
// The list grants only the Admin portal and agent traces; no student, officer
// or company data. The account must already exist (sign up first).
//   npm run access:admin -- person@example.com
//   npm run access:admin -- person@example.com --revoke
import { createPool } from "../src/integrations/supabase/db.js";

const [email, flag] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (flag && flag !== "--revoke")) {
  console.error("Usage: npm run access:admin -- <account-email> [--revoke]");
  process.exit(1);
}
if (!process.env.DATABASE_ADMIN_URL) {
  console.error("DATABASE_ADMIN_URL is not set. Put the operator connection in .env.operator.");
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_ADMIN_URL);
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  const user = (await client.query("SELECT id FROM auth.users WHERE lower(email)=lower($1)", [email.trim()])).rows[0];
  if (!user) throw Object.assign(new Error("No account uses that email. Sign up first."), { expose: true });
  if (flag === "--revoke") {
    const { rowCount } = await client.query("UPDATE ops.admins SET active=false,revoked_at=now() WHERE user_id=$1 AND active", [user.id]);
    await client.query("INSERT INTO erp.audit_events(action,resource_id) VALUES('admin.revoke',$1)", [user.id]);
    console.log(rowCount ? "Admin access removed." : "That account was not an active admin.");
  } else {
    await client.query(
      "INSERT INTO ops.admins(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET active=true,revoked_at=NULL",
      [user.id],
    );
    await client.query("INSERT INTO erp.audit_events(action,resource_id) VALUES('admin.grant',$1)", [user.id]);
    console.log("Admin access granted. The account opens /admin after signing in.");
  }
  await client.query("COMMIT");
} catch (error) {
  if (client) await client.query("ROLLBACK").catch(() => {});
  console.error(error.expose ? error.message : `Admin access could not be changed (${error.code || "ERROR"}). Run npm run db:migrate first if ops.admins is missing.`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
