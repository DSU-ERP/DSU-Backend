import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ELIGIBILITY_RULES, PLACEMENT_SCOPE_RULES } from "../src/modules/students/friday-context.js";
import { PLACEMENT_POLICY } from "../src/modules/analytics/placementPolicy.js";

test("student FRIDAY states the same placement rule as the officer portal", async () => {
  assert.equal(PLACEMENT_POLICY.minimumCgpa, "6.75");
  assert.match(ELIGIBILITY_RULES, /valid official CGPA of 6\.75 or above/);
  assert.match(ELIGIBILITY_RULES, /compare their CGPA with 6\.75/);
  assert.match(PLACEMENT_SCOPE_RULES, /Never write internal field names such as myPlacement/);
  // The chat task includes the rule.
  assert.match(await readFile(new URL("../src/modules/students/chat.js", import.meta.url), "utf8"), /\$\{PLACEMENT_SCOPE_RULES\} \$\{ELIGIBILITY_RULES\}/);
});
