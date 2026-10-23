import test from "node:test";
import assert from "node:assert/strict";
import {
  ONBOARDING_VERSION,
  OPTIONAL_PLATFORMS,
  REQUIRED_PLATFORMS,
  onboardingStatus,
} from "../src/modules/intelligence/constants.js";

test("skills onboarding requires linked GitHub, LeetCode and LinkedIn only", () => {
  assert.equal(ONBOARDING_VERSION, 2);
  assert.deepEqual(REQUIRED_PLATFORMS, ["github", "leetcode", "linkedin"]);
  assert.deepEqual(OPTIONAL_PLATFORMS, ["hackerrank", "huggingface", "kaggle"]);

  const profile = {
    onboarding_version: 2,
    identity_confirmed_at: "2026-10-23T00:00:00Z",
    visibility_saved_at: "2026-10-23T00:00:00Z",
  };
  const linkedRequired = ["github", "leetcode", "linkedin"].map((platform) => ({ platform, state: "linked" }));
  const optionalMissing = onboardingStatus(profile, linkedRequired);
  assert.equal(optionalMissing.complete, true);
  assert.deepEqual(optionalMissing.missing, []);

  const missingLinkedIn = onboardingStatus(profile, [...linkedRequired.slice(0, 2), { platform: "linkedin", state: "declared_none" }]);
  assert.equal(missingLinkedIn.complete, false);
  assert.deepEqual(missingLinkedIn.missing, ["linkedin"]);
});
