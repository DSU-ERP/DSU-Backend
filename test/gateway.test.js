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
