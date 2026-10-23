import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { databaseChecks, projectRef, staticChecks } from "../src/platform/devguard.js";

const DEV_REF = "abcdefghijklmnopqrst";
const LIVE_REF = "idioblehzhaibtgotfjk";
const good = {
  DSU_ENVIRONMENT: "development",
  DEV_SUPABASE_URL: `https://${DEV_REF}.supabase.co`,
  DEV_DATABASE_ADMIN_URL: `postgresql://postgres:pw@db.${DEV_REF}.supabase.co:5432/postgres`,
  DEV_SUPABASE_SERVICE_ROLE_KEY: "service-role",
};
const known = {
  SUPABASE_URL: `https://${LIVE_REF}.supabase.co`,
  DATABASE_URL: "postgresql://dsu_api.x:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
  DATABASE_ADMIN_URL: `postgresql://postgres:pw@db.${LIVE_REF}.supabase.co:5432/postgres`,
};
const has = (result, pattern) => result.reasons.some((r) => pattern.test(r));

test("dev provisioning: static guard refusals", () => {
  assert.equal(projectRef(`https://${DEV_REF}.supabase.co`), DEV_REF);
  assert.equal(projectRef("https://example.com"), null);
  const ok = staticChecks(good, ["--apply"], known);
  assert.deepEqual(ok, { ok: true, apply: true, reasons: [] });
  assert.equal(staticChecks(good, [], known).apply, false, "dry run unless --apply");

  assert.ok(has(staticChecks({ ...good, DSU_ENVIRONMENT: "production" }, [], known), /DSU_ENVIRONMENT/));
  assert.ok(has(staticChecks({ ...good, DSU_ENVIRONMENT: undefined }, [], known), /DSU_ENVIRONMENT/));
  // The live project ref is always protected, even with no other configuration.
  const live = { ...good, DEV_SUPABASE_URL: `https://${LIVE_REF}.supabase.co`, DEV_DATABASE_ADMIN_URL: `postgresql://postgres:pw@db.${LIVE_REF}.example:5432/postgres` };
  assert.ok(has(staticChecks(live, [], {}), /protected project/));
  assert.ok(has(staticChecks(live, [], {}), /DEV_DATABASE_ADMIN_URL refers to a protected project/));
  assert.ok(has(staticChecks({ ...good, DSU_PROTECTED_PROJECT_REFS: `zzzzzzzzzzzzzzzzzzzz, ${DEV_REF}` }, [], known), /protected project/));
  // Same project as the runtime SUPABASE_URL.
  assert.ok(has(staticChecks(good, [], { ...known, SUPABASE_URL: `https://${DEV_REF}.supabase.co/` }), /same project as SUPABASE_URL/));
  // Same database host as the runtime or operator connection.
  assert.ok(has(staticChecks(good, [], { ...known, DATABASE_URL: good.DEV_DATABASE_ADMIN_URL }), /same host as DATABASE_URL/));
  assert.ok(has(staticChecks(good, [], { ...known, DATABASE_ADMIN_URL: `postgresql://other:pw@db.${DEV_REF}.supabase.co/postgres` }), /same host as DATABASE_ADMIN_URL/));
  assert.ok(has(staticChecks({ ...good, DEV_SUPABASE_URL: undefined }, [], known), /DEV_SUPABASE_URL/));
  assert.ok(has(staticChecks({ ...good, DEV_DATABASE_ADMIN_URL: undefined }, [], known), /DEV_DATABASE_ADMIN_URL must be set/));
  assert.ok(has(staticChecks({ ...good, DEV_SUPABASE_SERVICE_ROLE_KEY: undefined }, ["--apply"], known), /SERVICE_ROLE_KEY/));
  assert.equal(staticChecks({ ...good, DEV_SUPABASE_SERVICE_ROLE_KEY: undefined }, [], known).ok, true, "dry run needs no key");
});

test("dev provisioning: database guard refusals with a fake query", async () => {
  const fake = ({ present = true, values = ["isolated-development"], real = 0 } = {}) => {
    const seen = [];
    const query = async (sql, params) => {
      seen.push(sql);
      assert.ok(!/CREATE|INSERT|UPDATE|DELETE/i.test(sql), "guard never writes");
      if (sql.includes("to_regclass")) return { rows: [{ present }] };
      if (sql.includes("environment_marker")) return { rows: values.map((value) => ({ value })) };
      if (sql.includes("erp.students")) {
        assert.deepEqual(params, ["DEV%"]);
        return { rows: [{ n: real }] };
      }
      throw new Error("unexpected " + sql);
    };
    return { query, seen };
  };
  assert.deepEqual(await databaseChecks(fake().query), { ok: true, reasons: [] });
  assert.match((await databaseChecks(fake({ present: false }).query)).reasons.join(), /environment_marker is missing/);
  assert.match((await databaseChecks(fake({ values: ["production"] }).query)).reasons.join(), /must be 'isolated-development'/);
  assert.match((await databaseChecks(fake({ values: [] }).query)).reasons.join(), /must be 'isolated-development'/);
  assert.match((await databaseChecks(fake({ real: 3 }).query)).reasons.join(), /outside the synthetic DEV prefix/);
});

test("dev provisioning: npm script loads no env files and never grants elevated roles", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["dev:provision-student"], "node scripts/provision-dev-student.js");
  assert.equal(pkg.dependencies.octokit, "5.0.5");
  const script = readFileSync(new URL("../scripts/provision-dev-student.js", import.meta.url), "utf8");
  assert.ok(!/'admin'|'staff'|placement\.officers/.test(script));
  assert.ok(/--apply/.test(script) && /staticChecks/.test(script) && /databaseChecks/.test(script));
  assert.ok(!/createPool\(env\.DATABASE/.test(script), "never connects to the runtime or operator database");
});
