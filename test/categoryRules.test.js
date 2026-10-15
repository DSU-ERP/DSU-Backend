import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_RULES,
  classifyCgpa,
  categorySql,
  compareDecimal,
} from "../src/modules/analytics/categoryRules.js";
import {
  categoryCsv,
  cohortQuery,
} from "../src/modules/analytics/studentAnalytics.js";
import { HEADERS, normalizeStudent } from "../src/modules/imports/csv.js";

const boundaries = [
  ["10.00", "advanced"],
  ["9.25", "advanced"],
  ["8.50", "advanced"],
  ["8.499", "medium"],
  ["8.49", "medium"],
  ["7.50", "medium"],
  ["6.75", "medium"],
  ["6.749", "needs-improvement"],
  ["6.74", "needs-improvement"],
  ["6.50", "needs-improvement"],
  ["6.49", "needs-improvement"],
  ["5.00", "needs-improvement"],
  ["0.00", "needs-improvement"],
  [null, null],
];
for (const [value, expected] of boundaries)
  test(`CGPA ${value} maps to ${expected || "unclassified"}`, () => {
    assert.equal(classifyCgpa(value), expected);
    if (value !== null) assert.equal(classifyCgpa(Number(value)), expected);
  });
test("missing, invalid, nonfinite and out-of-scale values are never treated as zero", () => {
  for (const value of [
    undefined,
    "",
    " ",
    "abc",
    true,
    false,
    {},
    [],
    "10.01",
    "-0.01",
    NaN,
    Infinity,
    "NaN",
    "Infinity",
  ])
    assert.equal(classifyCgpa(value), null);
  assert.equal(classifyCgpa(0), "needs-improvement");
  assert.equal(classifyCgpa(1e-7), "needs-improvement");
});
test("arbitrary stored decimal precision never rounds across thresholds", () => {
  assert.equal(
    classifyCgpa("8.499999999999999999999999999999999999"),
    "medium",
  );
  assert.equal(
    classifyCgpa("6.749999999999999999999999999999999999"),
    "needs-improvement",
  );
  assert.equal(
    classifyCgpa("8.500000000000000000000000000000000001"),
    "advanced",
  );
});
test("all 10,001 valid hundredth and thousandth samples belong to exactly one defined category", () => {
  assert.equal(CATEGORY_RULES.length, 3);
  assert.equal(new Set(CATEGORY_RULES.map((rule) => rule.id)).size, 3);
  for (let value = 0; value <= 10000; value++) {
    const actual = classifyCgpa((value / 1000).toFixed(3));
    assert.equal(CATEGORY_RULES.filter((rule) => rule.id === actual).length, 1);
  }
});
test("SQL thresholds use bound exact decimals and reject unsafe column identifiers", () => {
  const values = [];
  const sql = categorySql("a.cgpa", (value) => {
    values.push(value);
    return `$${values.length}`;
  });
  assert.ok(sql.includes("::numeric"));
  assert.ok(
    CATEGORY_RULES.every(
      (rule) => rule.minimum === null || values.includes(rule.minimum),
    ),
  );
  assert.throws(() =>
    categorySql("a.cgpa; DROP TABLE erp.students", () => "$1"),
  );
  const q = cohortQuery({
    search: "O'Brien_%",
    department: "X'; DELETE",
    batch: "2026",
  });
  assert.ok(!q.sql.includes("O'Brien"));
  assert.ok(!q.sql.includes("DELETE"));
  assert.ok(q.values.includes("%O'Brien\\_\\%%"));
});
test("exports preserve precise CGPA and neutralize spreadsheet formulas", () => {
  const csv = categoryCsv(
    [
      {
        rank: 1,
        enrollment_no: "=HYPERLINK(1)",
        full_name: "+SUM(1)",
        department_short_name: "CSE",
        source_batch: "2026",
        cgpa: "8.499",
      },
    ],
    "medium",
  );
  assert.ok(csv.includes('"8.499"'));
  assert.ok(csv.includes('"Medium"'));
  assert.ok(csv.includes("'="));
  assert.ok(csv.includes("'+"));
  assert.ok(csv.includes('"Eligible"'));
});
test("CSV imports preserve decimal precision without changing ordinary normalized values", () => {
  const row = Object.fromEntries(HEADERS.map((key) => [key, ""]));
  Object.assign(row, {
    enrollmentNo: "TEST-PRECISE",
    studentFullName: "Synthetic Student",
    cgpa: "8.499999999999999999999999",
  });
  const normalized = normalizeStudent(row, "2026");
  assert.equal(compareDecimal(normalized.academic.cgpa, row.cgpa), 0);
  assert.equal(classifyCgpa(normalized.academic.cgpa), "medium");
  assert.equal(
    normalizeStudent({ ...row, cgpa: "0" }, "2026").academic.cgpa,
    0,
  );
});
