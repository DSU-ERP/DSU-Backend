import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
const id = "b3c3a760-94ab-4542-8bcb-9c40e87ed165";
const env = { SERVICE_TOKEN: "a".repeat(64), ENABLE_PUBLIC_GATEWAY: "true" };
const routes = [
  "/analytics",
  "/batch-analytics",
  "/student-categories",
  "/student-categories/medium",
  "/student-categories/medium/export",
];
test("analytics, lists and exports deny anonymous and student access in both deployment modes", async (t) => {
  const queries = [];
  const pool = {
    end: async () => {},
    connect: async () => ({
      release() {},
      query: async (sql) => {
        queries.push(sql);
        return {
          rows: sql.startsWith("SELECT role") ? [{ role: "student" }] : [],
        };
      },
    }),
  };
  const app = await buildApp({
    env,
    pool,
    verify: async () => ({ id }),
    logger: false,
  });
  t.after(() => app.close());
  for (const prefix of ["/v1", "/api/v1"])
    for (const route of routes) {
      assert.equal((await app.inject(prefix + route)).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: prefix + route,
            headers: {
              authorization: "Bearer verified",
              "x-service-token": env.SERVICE_TOKEN,
            },
          })
        ).statusCode,
        403,
      );
    }
  assert.ok(!queries.some((sql) => sql.includes("WITH cohort")));
});
test("staff cannot export and unlinked users cannot read analytics", async (t) => {
  for (const role of ["staff", null]) {
    const pool = {
      end: async () => {},
      connect: async () => ({
        release() {},
        query: async (sql) => ({
          rows: sql.startsWith("SELECT role") && role ? [{ role }] : [],
        }),
      }),
    };
    const app = await buildApp({
      env,
      pool,
      verify: async () => ({ id }),
      logger: false,
    });
    t.after(() => app.close());
    const route = role ? "/student-categories/advanced/export" : "/analytics";
    assert.equal(
      (
        await app.inject({
          url: `/api/v1${route}`,
          headers: { authorization: "Bearer verified" },
        })
      ).statusCode,
      403,
    );
  }
});
test("unknown categories and invalid query parameters fail without running cohort SQL", async (t) => {
  const app = await buildApp({
    env,
    pool: { end: async () => {} },
    verify: async () => ({ id }),
    logger: false,
  });
  t.after(() => app.close());
  for (const [route, status] of [
    ["/student-categories/unknown", 404],
    ["/student-categories/medium?page=0", 400],
    ["/analytics?batch=bad", 400],
    ["/analytics?department=a&department=b", 400],
    ["/analytics?eligibility=eligible", 400],
  ])
    assert.equal(
      (
        await app.inject({
          url: `/api/v1${route}`,
          headers: { authorization: "Bearer verified" },
        })
      ).statusCode,
      status,
    );
});
