import test from "node:test";
import assert from "node:assert/strict";
import { testingTargetChecks, TESTING_PROJECT_REF } from "../src/platform/testing-guard.js";

const safe = {
  DSU_ENVIRONMENT: "testing",
  TESTING_SUPABASE_PROJECT_REF: TESTING_PROJECT_REF,
  TESTING_SUPABASE_URL: `https://${TESTING_PROJECT_REF}.supabase.co`,
  TESTING_DATABASE_ADMIN_URL: `postgresql://postgres.${TESTING_PROJECT_REF}:password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`,
};
test("accepts only the declared isolated Supabase testing project", () => {
  assert.equal(testingTargetChecks(safe).ok, true);
});
test("rejects production and mismatched database targets", () => {
  assert.equal(testingTargetChecks({...safe, TESTING_SUPABASE_URL:"https://idioblehzhaibtgotfjk.supabase.co"}).ok, false);
  assert.equal(testingTargetChecks({...safe, TESTING_DATABASE_ADMIN_URL:"postgresql://postgres.idioblehzhaibtgotfjk:password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres"}).ok, false);
});
