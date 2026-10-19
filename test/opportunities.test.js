import test from "node:test";
import assert from "node:assert/strict";
import { opportunityEligibility } from "../src/modules/students/opportunities.js";

const student = { cgpa: "8.10", current_backlog: 0, department_short_name: "CSE" };
const drive = {
  min_cgpa: "7.00", max_backlogs: 0, branches: [], package_lpa: "6",
  published: true, status: "upcoming",
};

test("an expired registration deadline blocks applications for text and Date values", () => {
  for (const deadline of ["2026-10-01", new Date("2026-10-01T00:00:00+05:30")]) {
    const result = opportunityEligibility(student, { ...drive, registration_deadline: deadline }, 0, "2026-10-19");
    assert.equal(result.eligible, false);
    assert.ok(result.gaps.includes("The registration deadline has passed."));
  }
  const open = opportunityEligibility(student, { ...drive, registration_deadline: "2026-10-19" }, 0, "2026-10-19");
  assert.equal(open.eligible, true);
});
