import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
test("users behind the same web server have separate rate budgets", async t => {
  const client = { release() {}, query: async sql => ({ rows: sql.startsWith("SELECT role,") ? [{ role: "student", student_id: null }] : [] }) };
  const app = await buildApp({ pool: { connect: async () => client, end: async () => {}, query: async () => ({ rows: [] }) }, env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 2 }, logger: false, verify: async token => ({ id: token }) });
  t.after(() => app.close());
  const request = token => app.inject({ url: "/api/v1/me", headers: { authorization: "Bearer " + token } });
  assert.equal((await request("user-a")).statusCode, 200);
  assert.equal((await request("user-a")).statusCode, 200);
  assert.equal((await request("user-a")).statusCode, 429);
  assert.equal((await request("user-b")).statusCode, 200);
  assert.equal((await app.inject("/health/live")).statusCode, 200);
});
