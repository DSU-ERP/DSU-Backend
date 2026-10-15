import test from "node:test";
import assert from "node:assert/strict";
import { buildApp, httpError } from "../src/app.js";

const id = "b3c3a760-94ab-4542-8bcb-9c40e87ed165";
const env = { SERVICE_TOKEN: "c".repeat(64), ENABLE_PUBLIC_GATEWAY: "true" };
const headers = { authorization: "Bearer valid-test-session" };

function fixture(role = "admin") {
  const queries = [];
  const client = {
    release() {},
    async query(sql, args) {
      queries.push({ sql, args });
      if (sql.startsWith("SELECT role, student_id"))
        return {
          rows: role
            ? [{ role, student_id: role === "student" ? id : null }]
            : [],
        };
      if (sql.startsWith("SELECT id,enrollment_no")) return { rows: [{ id }] };
      return { rows: [] };
    },
  };
  return {
    queries,
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => client,
      end: async () => {},
    },
    verify: async (token) => {
      if (token !== "valid-test-session")
        throw httpError(401, "UNAUTHENTICATED", "Invalid session");
      return { id };
    },
  };
}

// Contract change recorded by the API/backend consolidation: /api/v1 used to
// be opt-in behind ENABLE_PUBLIC_GATEWAY because a separate gateway process
// owned the public surface. That process is retired, so /api/v1 is now the
// permanent public contract and the flag is ignored. /v1 is unchanged and
// still requires the service credential, so the previous contract keeps
// working during cutover.
test("public gateway is always available and the private prefix still requires service authentication", async (t) => {
  for (const flag of ["false", "true", undefined]) {
    const app = await buildApp({
      ...fixture(),
      env: { ...env, ENABLE_PUBLIC_GATEWAY: flag },
      logger: false,
    });
    t.after(() => app.close());
    assert.equal(
      (await app.inject({ url: "/api/v1/me", headers })).statusCode,
      200,
      `/api/v1 must serve regardless of ENABLE_PUBLIC_GATEWAY=${String(flag)}`,
    );
    // Unchanged: the private prefix rejects a user token with no service token.
    assert.equal(
      (await app.inject({ url: "/v1/me", headers })).statusCode,
      401,
    );
  }
});

test("every public gateway route requires a valid user even with a service credential", async (t) => {
  const f = fixture();
  const app = await buildApp({ ...f, env, logger: false });
  t.after(() => app.close());
  for (const path of [
    "/me",
    "/overview",
    "/students",
    `/students/${id}`,
    "/imports",
  ]) {
    const res = await app.inject({
      url: `/api/v1${path}`,
      headers: { "x-service-token": env.SERVICE_TOKEN },
    });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/imports?batch=2026",
        headers: { "content-type": "text/csv" },
        payload: "test",
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/me",
        headers: { authorization: "Bearer fake" },
      })
    ).statusCode,
    401,
  );
  assert.equal(f.queries.length, 0);
  assert.equal((await app.inject("/api/v1/arbitrary")).statusCode, 404);
});

test("public and private membership responses match and use the same database actor", async (t) => {
  const f = fixture();
  const app = await buildApp({ ...f, env, logger: false });
  t.after(() => app.close());
  const publicResponse = await app.inject({ url: "/api/v1/me", headers });
  const privateResponse = await app.inject({
    url: "/v1/me",
    headers: { ...headers, "x-service-token": env.SERVICE_TOKEN },
  });
  assert.deepEqual(publicResponse.json(), privateResponse.json());
  assert.equal(publicResponse.json().data.role, "admin");
  assert.equal(publicResponse.headers["cache-control"], "no-store");
  const actorQueries = f.queries.filter((q) =>
    q.sql.includes("set_config('app.user_id'"),
  );
  assert.equal(actorQueries.length, 2);
  assert.ok(actorQueries.every((q) => q.args[0] === id));
});

test("combined mode retains unlinked-account, student, and staff restrictions", async (t) => {
  for (const role of [null, "student", "staff"]) {
    const f = fixture(role);
    const app = await buildApp({ ...f, env, logger: false });
    t.after(() => app.close());
    if (role !== "staff")
      assert.equal(
        (await app.inject({ url: "/api/v1/students", headers })).statusCode,
        403,
      );
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/imports?batch=2026",
      headers: { ...headers, "content-type": "text/csv" },
      payload: "test",
    });
    assert.equal(uploaded.statusCode, 403);
    assert.ok(
      !f.queries.some((q) => q.sql.includes("INSERT INTO erp.students")),
    );
    if (role === "staff") {
      const detail = await app.inject({
        url: `/api/v1/students/${id}`,
        headers,
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().data.contact, null);
      assert.equal(detail.json().data.fees, null);
      assert.ok(!f.queries.some((q) => q.sql.includes("erp.contacts")));
    }
  }
});

test("combined mode retains input validation and import rate limits", async (t) => {
  const app = await buildApp({ ...fixture(), env, logger: false });
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ url: "/api/v1/students?limit=10001", headers }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ url: "/api/v1/students/invalid", headers })).statusCode,
    400,
  );
  for (let i = 0; i < 6; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports?batch=invalid",
      headers: { ...headers, "content-type": "text/csv" },
      payload: "test",
    });
    assert.equal(res.statusCode, i < 5 ? 400 : 429);
  }
});
