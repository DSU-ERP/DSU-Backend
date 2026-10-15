import test from "node:test";
import assert from "node:assert/strict";
import { buildApp, httpError, sameSecret } from "../src/app.js";
const env = {
  SERVICE_TOKEN: "a".repeat(64),
  CORS_ORIGINS: "https://campus.example",
};
const pool = { query: async () => ({ rows: [] }), end: async () => {} };
test("requires service secret and valid user before attempting database access", async () => {
  const app = await buildApp({
    pool,
    env,
    logger: false,
    verify: async () => {
      throw httpError(401, "UNAUTHENTICATED", "Invalid session");
    },
  });
  assert.equal((await app.inject("/v1/students")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/v1/students",
        headers: {
          "x-service-token": env.SERVICE_TOKEN,
          authorization: "Bearer fake",
        },
      })
    ).statusCode,
    401,
  );
  assert.equal((await app.inject("/health/live")).statusCode, 200);
  await app.close();
});
test("does not allow unlisted browser origins or cache student API responses", async () => {
  const app = await buildApp({ pool, env, logger: false });
  const res = await app.inject({
    url: "/health/live",
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(res.headers["cache-control"], "no-store");
  await app.close();
});
test("secret comparison rejects unicode and length mismatches safely", () => {
  assert.equal(sameSecret("é".repeat(64), env.SERVICE_TOKEN), false);
  assert.equal(sameSecret("wrong", env.SERVICE_TOKEN), false);
  assert.equal(sameSecret(env.SERVICE_TOKEN, env.SERVICE_TOKEN), true);
});
