// Real PostgreSQL numeric/query verification. Only temporary tables are written;
// every change is rolled back. No student names or identifiers are logged.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../src/integrations/supabase/db.js";
import { placementEligibility } from "../src/modules/analytics/placementPolicy.js";
import {
  analyticsSummary,
  categoryStudents,
  batchBreakdown,
  filterOptions,
} from "../src/modules/analytics/studentAnalytics.js";
import {
  CATEGORY_RULES,
  classifyCgpa,
  compareDecimal,
} from "../src/modules/analytics/categoryRules.js";

const pool = createPool(process.env.DATABASE_ADMIN_URL);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `CREATE TEMP TABLE analytics_students(id uuid PRIMARY KEY,enrollment_no text UNIQUE,full_name text,department_short_name text,source_batch text) ON COMMIT DROP`,
  );
  await client.query(
    `CREATE TEMP TABLE analytics_academics(student_id uuid PRIMARY KEY,cgpa numeric) ON COMMIT DROP`,
  );
  const values = [
    "10.00",
    "9.25",
    "8.50",
    "8.499",
    "8.49",
    "7.50",
    "6.75",
    "6.749",
    "6.74",
    "6.50",
    "6.49",
    "5.00",
    "0.00",
    null,
    "8.50",
    "11",
    "-1",
    "NaN",
    "8.499999999999999999999999999999",
    null,
  ];
  const fixtures = [];
  for (const [index, cgpa] of values.entries()) {
    const row = {
      id: randomUUID(),
      enrollment_no: `TEST-${String(index).padStart(3, "0")}`,
      full_name: index === 3 ? "Synthetic O'Brien_%" : "Synthetic Student",
      department_short_name: index % 2 ? "CSE" : "ECE",
      source_batch: index % 3 ? "2026" : "2027",
      cgpa,
    };
    fixtures.push(row);
    await client.query(
      "INSERT INTO analytics_students VALUES ($1,$2,$3,$4,$5)",
      [
        row.id,
        row.enrollment_no,
        row.full_name,
        row.department_short_name,
        row.source_batch,
      ],
    );
    if (index !== values.length - 1)
      await client.query("INSERT INTO analytics_academics VALUES($1,$2)", [
        row.id,
        cgpa,
      ]);
  }
  const fixtureClient = {
    query: (sql, args) =>
      client.query(
        sql
          .replaceAll("erp.students", "pg_temp.analytics_students")
          .replaceAll("erp.academics", "pg_temp.analytics_academics"),
        args,
      ),
  };
  for (const filters of [
    {},
    { batch: "2026" },
    { department: "CSE" },
    { batch: "2026", department: "CSE" },
    { search: "O'Brien_%" },
    { search: "TEST-" },
    { batch: "2099" },
  ]) {
    const selected = fixtures.filter(
      (s) =>
        (!filters.batch || s.source_batch === filters.batch) &&
        (!filters.department ||
          s.department_short_name === filters.department) &&
        (!filters.search ||
          [s.full_name, s.enrollment_no].some((value) =>
            value.toLowerCase().includes(filters.search.toLowerCase()),
          )),
    );
    const summary = await analyticsSummary(fixtureClient, filters);
    assert.equal(summary.total, selected.length);
    assert.equal(
      summary.valid,
      selected.filter((s) => classifyCgpa(s.cgpa) !== null).length,
    );
    assert.equal(
      summary.unclassified,
      selected.filter((s) => classifyCgpa(s.cgpa) === null).length,
    );
    assert.equal(
      summary.categories.reduce((n, s) => n + s.count, 0),
      summary.valid,
    );
    assert.equal(summary.valid + summary.unclassified, summary.total);
    assert.equal(
      summary.distribution.reduce((n, s) => n + s.count, 0),
      summary.valid,
    );
    assert.equal(summary.placementPolicy.configured, true);
    const combinedIds = new Set();
    for (const rule of CATEGORY_RULES) {
      const stats = summary.categories.find((s) => s.id === rule.id);
      const expected = selected
        .filter((s) => classifyCgpa(s.cgpa) === rule.id)
        .sort(
          (a, b) =>
            -compareDecimal(a.cgpa, b.cgpa) ||
            a.enrollment_no.localeCompare(b.enrollment_no),
        );
      assert.equal(stats.count, expected.length);
      assert.equal(
        stats.percentage,
        summary.total ? (expected.length * 100) / summary.total : 0,
      );
      const eligibleCount=expected.filter(s=>placementEligibility(s.cgpa)===true).length;
      assert.equal(stats.eligibleCount, eligibleCount);
      assert.equal(stats.eligibilityPercentage, expected.length ? 100*eligibleCount/expected.length : 0);
      const all = await categoryStudents(
        fixtureClient,
        filters,
        rule.id,
        summary,
        true,
      );
      assert.deepEqual(
        all.students.map((s) => s.id),
        expected.map((s) => s.id),
      );
      for (const [index, s] of all.students.entries()) {
        assert.equal(s.placement_eligible, placementEligibility(s.cgpa));
        assert.ok(!combinedIds.has(s.id));
        combinedIds.add(s.id);
        assert.equal(
          s.rank,
          expected.findIndex(
            (other) => compareDecimal(other.cgpa, s.cgpa) === 0,
          ) + 1,
        );
      }
      const page1 = await categoryStudents(
        fixtureClient,
        { ...filters, limit: 2, page: 1 },
        rule.id,
        summary,
      );
      assert.deepEqual(
        page1.students.map((s) => s.id),
        expected.slice(0, 2).map((s) => s.id),
      );
      if (expected.length > 2) {
        const page2 = await categoryStudents(
          fixtureClient,
          { ...filters, limit: 2, page: 2 },
          rule.id,
          summary,
        );
        assert.deepEqual(
          page2.students.map((s) => s.id),
          expected.slice(2, 4).map((s) => s.id),
        );
      }
      const clamped = await categoryStudents(
        fixtureClient,
        { ...filters, limit: 2, page: 999 },
        rule.id,
        summary,
      );
      assert.equal(
        clamped.pagination.page,
        Math.max(1, Math.ceil(expected.length / 2)),
      );
    }
    const batches = await batchBreakdown(fixtureClient, filters);
    assert.equal(
      batches.reduce((n, b) => n + b.total, 0),
      summary.total,
    );
    for (const b of batches)
      assert.equal(
        CATEGORY_RULES.reduce((n, r) => n + b[r.id], 0) + b.unclassified,
        b.total,
      );
  }
  const options = await filterOptions(fixtureClient);
  assert.deepEqual(options.batches, ["2027", "2026"]);
  console.log(
    "PostgreSQL analytics verified: exact boundaries, null/invalid exclusion, filters, ties, ranking, pagination, distribution and batch reconciliation.",
  );
} catch (error) {
  console.error("Analytics verification failed:", error.code || error.message);
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
