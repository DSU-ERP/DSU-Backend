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

test("per-IP limits use the forwarded browser IP only with a valid service token", async t => {
  const client = { release() {}, query: async () => ({ rows: [] }) };
  const token = "x".repeat(32);
  const app = await buildApp({ pool: { connect: async () => client, end: async () => {}, query: async () => ({ rows: [] }) }, env: { SERVICE_TOKEN: token, RATE_LIMIT_IP_MAX: 2 }, logger: false, verify: async t => ({ id: t }) });
  t.after(() => app.close());
  const request = (ip, serviceToken) => app.inject({ url: "/api/v1/unknown", headers: { "x-dsu-client-ip": ip, ...(serviceToken ? { "x-service-token": serviceToken } : {}) } });
  // Trusted: separate browsers behind the web server get separate budgets.
  assert.notEqual((await request("203.0.113.1", token)).statusCode, 429);
  assert.notEqual((await request("203.0.113.1", token)).statusCode, 429);
  assert.equal((await request("203.0.113.1", token)).statusCode, 429);
  assert.notEqual((await request("203.0.113.2", token)).statusCode, 429);
  // Untrusted: a spoofed header without the token is ignored (shares req.ip).
  const spoof = await Promise.all([request("198.51.100.1"), request("198.51.100.2"), request("198.51.100.3")]);
  assert.ok(spoof.some(r => r.statusCode === 429), "spoofed client IPs do not get fresh budgets");
});
