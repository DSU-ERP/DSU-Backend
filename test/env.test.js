import test from "node:test";
import assert from "node:assert/strict";
import { readEnv } from "../src/config/env.js";
const valid = { DATABASE_URL: "postgresql://dsu_api:secret@localhost/erp", SUPABASE_URL: "https://test.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SERVICE_TOKEN: "x".repeat(32) };
test("runtime config validates production dependencies without exposing credentials", () => {
  assert.equal(readEnv(valid).PORT, 4000);
  assert.equal(readEnv(valid).DATABASE_POOL_MAX, 5);
  assert.throws(() => readEnv({ ...valid, NODE_ENV: "production" }), /RATE_LIMIT_MODE/);
  assert.throws(() => readEnv({ ...valid, DATABASE_POOL_MAX: "0" }), /DATABASE_POOL_MAX/);
  assert.throws(() => readEnv({ ...valid, CORS_ORIGINS: "*" }), /CORS_ORIGINS/);
  try { readEnv({ ...valid, DATABASE_URL: "credential-that-must-not-leak" }); }
  catch (error) { assert.ok(!error.message.includes("credential-that-must-not-leak")); }
  assert.equal(readEnv({ ...valid, NODE_ENV: "production", ASSESSMENT_CODE_SECRET:"c".repeat(32), RATE_LIMIT_MODE: "redis", REDIS_URL: "redis://localhost:6379" }).NODE_ENV, "production");
});
