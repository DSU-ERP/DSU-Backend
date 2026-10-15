import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
const userId = "b3c3a760-94ab-4542-8bcb-9c40e87ed165";
const env = { SERVICE_TOKEN: "b".repeat(64) };
const headers = {
  authorization: "Bearer verified-test-token",
  "x-service-token": env.SERVICE_TOKEN,
};
function fixture(role) {
  const queries = [];
  const client = {
    release() {},
    async query(sql, args) {
      queries.push({ sql, args });
      if (sql.startsWith("SELECT role, student_id"))
        return { rows: role ? [{ role, student_id: null }] : [] };
      return { rows: [] };
    },
  };
  return {
    queries,
    pool: { connect: async () => client, end: async () => {} },
    verify: async () => ({ id: userId }),
  };
}
test("an authenticated but unlinked account cannot read data", async () => {
  const f = fixture(null);
  const app = await buildApp({ ...f, env, logger: false });
  const r = await app.inject({ url: "/v1/students", headers });
  assert.equal(r.statusCode, 403);
  assert.ok(!f.queries.some((q) => q.sql.includes("FROM erp.students")));
  await app.close();
});
test("student cannot browse directory or upload CSV; staff cannot import", async () => {
  for (const role of ["student", "staff"]) {
    const f = fixture(role);
    const app = await buildApp({ ...f, env, logger: false });
    if (role === "student")
      assert.equal(
        (await app.inject({ url: "/v1/students", headers })).statusCode,
        403,
      );
    const r = await app.inject({
      method: "POST",
      url: "/v1/imports?batch=2026",
      headers: { ...headers, "content-type": "text/csv" },
      payload: "not a real export",
    });
    assert.equal(r.statusCode, 403);
    assert.ok(
      !f.queries.some((q) => q.sql.includes("INSERT INTO erp.students")),
    );
    await app.close();
  }
});
test("invalid pagination and identifiers fail before record queries", async () => {
  const f = fixture("admin");
  const app = await buildApp({ ...f, env, logger: false });
  for (const url of [
    "/v1/students?limit=10000",
    "/v1/students?page=-1",
    "/v1/students/not-a-uuid",
  ])
    assert.equal((await app.inject({ url, headers })).statusCode, 400);
  assert.ok(!f.queries.some((q) => q.sql.includes("FROM erp.students")));
  await app.close();
});
test("staff detail response omits contacts and finance even if academic data exists", async () => {
  const f = fixture("staff");
  const original = f.pool.connect;
  f.pool.connect = async () => {
    const c = await original();
    const query = c.query;
    c.query = async (sql, args) =>
      sql.startsWith("SELECT id,enrollment_no")
        ? { rows: [{ id: userId, full_name: "Synthetic record" }] }
        : query(sql, args);
    return c;
  };
  const app = await buildApp({ ...f, env, logger: false });
  const r = await app.inject({ url: `/v1/students/${userId}`, headers });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().data.contact, null);
  assert.equal(r.json().data.fees, null);
  assert.ok(!f.queries.some((q) => q.sql.includes("erp.contacts")));
  await app.close();
});
