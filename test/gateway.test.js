import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
const env = {
  DSU_API_URL: "http://localhost:4001",
  SERVICE_TOKEN: "a".repeat(64),
  CORS_ORIGINS: "https://campus.example",
};
test("forwards only approved routes and uses configured service credential", async () => {
  let received;
  const app = await buildApp({
    env,
    logger: false,
    request: async (url, opts) => {
      received = { url, opts };
      return Response.json({ data: [] });
    },
  });
  assert.equal((await app.inject("/api/v1/students")).statusCode, 401);
  const res = await app.inject({
    url: "/api/v1/students?search=Example",
    headers: {
      authorization: "Bearer user-token",
      "x-service-token": "attacker",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(received.opts.headers["x-service-token"], env.SERVICE_TOKEN);
  assert.equal(received.url.pathname, "/v1/students");
  assert.equal((await app.inject("/api/v1/arbitrary")).statusCode, 404);
  await app.close();
});
test("upstream failures are safe and readiness reflects dependency failure", async () => {
  const app = await buildApp({
    env,
    logger: false,
    request: async () => {
      throw new Error("secret connection detail");
    },
  });
  const res = await app.inject({
    url: "/api/v1/me",
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(res.statusCode, 503);
  assert.ok(!res.body.includes("secret connection"));
  assert.equal((await app.inject("/health/ready")).statusCode, 503);
  await app.close();
});
test("production configuration refuses plaintext upstream", async () => {
  await assert.rejects(
    buildApp({ env: { ...env, NODE_ENV: "production" }, logger: false }),
    /HTTPS/,
  );
});

test("analytics, category and export routes preserve authorized filters", async (t) => {
  const received = [];
  const app = await buildApp({
    env,
    logger: false,
    request: async (url, options) => {
      received.push({ url, options });
      return Response.json({ data: { total: 1 } });
    },
  });
  t.after(() => app.close());
  for (const route of [
    "/analytics",
    "/batch-analytics",
    "/student-categories",
    "/student-categories/needs-improvement",
    "/student-categories/medium/export",
  ]) {
    const response = await app.inject({
      url: `/api/v1${route}?batch=2026&department=CSE&search=TEST`,
      headers: { authorization: "Bearer user-token" },
    });
    assert.equal(response.statusCode, 200);
    const forwarded = received.at(-1);
    assert.equal(forwarded.url.pathname, `/v1${route}`);
    assert.equal(forwarded.url.searchParams.get("department"), "CSE");
    assert.equal(forwarded.url.searchParams.get("batch"), "2026");
    assert.equal(forwarded.options.headers.authorization, undefined);
    assert.equal(forwarded.options.headers.Authorization, "Bearer user-token");
  }
});
