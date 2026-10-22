import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { buildApp } from "../src/app.js";

test("a real HTTP connection survives processing longer than ten seconds", { timeout: 20000 }, async (t) => {
  const app = await buildApp({
    pool: { end: async () => {} },
    env: { SERVICE_TOKEN: "test-service-token".repeat(3) },
    verify: async () => ({ id: "unused" }),
    logger: false,
    research: { enabled: false, close: async () => {} },
  });
  t.after(() => app.close());
  // inject() bypasses sockets and would miss the original connection timeout.
  app.get("/health/slow-test", async () => {
    await setTimeout(10500);
    return { data: { completed: true } };
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${origin}/health/slow-test`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { completed: true } });
});
