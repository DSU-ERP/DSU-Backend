import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { HEADERS, normalizeStudent, processCsv } from "../src/modules/imports/csv.js";
const row = (overrides = {}) =>
  Object.fromEntries(
    HEADERS.map((h) => [
      h,
      {
        enrollmentNo: "TEST-001",
        studentFullName: "Synthetic Student",
        ...overrides,
      }[h] || "",
    ]),
  );
const csv = (rows) =>
  Readable.from([
    HEADERS.join(",") +
      "\n" +
      rows
        .map((r) =>
          HEADERS.map(
            (h) => '"' + String(r[h] || "").replaceAll('"', '""') + '"',
          ).join(","),
        )
        .join("\n"),
  ]);
test("normalization preserves leading zero IDs, zero metrics and credit balances", () => {
  const result = normalizeStudent(
    row({ enrollmentNo: "000123", cgpa: "0", feesOutstandingAmount: "-42.50" }),
    "2026",
  );
  assert.equal(result.enrollment_no, "000123");
  assert.equal(result.academic.cgpa, 0);
  assert.equal(result.academic.fees_outstanding, -42.5);
});
test("invalid metrics and missing identity are rejected without containing student values", () => {
  assert.throws(() => normalizeStudent(row({ cgpa: "11" }), "2026"), /cgpa/);
  assert.throws(
    () => normalizeStudent(row({ enrollmentNo: "" }), "2026"),
    /enrollmentNo/,
  );
});
test("quoted CSV, BOM, identical duplicates, conflict and invalid rows produce deterministic totals", async () => {
  const summary = await processCsv(
    csv([
      row({ studentFullName: "Synthetic, Example" }),
      row({ studentFullName: "Synthetic, Example" }),
      row({ studentFullName: "Conflicting Example" }),
      row({ enrollmentNo: "" }),
    ]),
    { batch: "2026", validateOnly: true },
  );
  assert.equal(summary.total, 4);
  assert.equal(summary.valid, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 2);
});
test("rejects malicious/unknown or duplicate headers before consuming records", async () => {
  await assert.rejects(
    processCsv(Readable.from(["__proto__,name\nx,y"]), { batch: "2026" }),
    /headers/,
  );
});
test("flushes bounded batches, hashes stable data and reports persistence counts", async () => {
  let calls = 0;
  const summary = await processCsv(
    csv([row(), row({ enrollmentNo: "TEST-002" })]),
    {
      batch: "2026",
      batchSize: 1,
      consume: async (rows) => {
        calls++;
        return { inserted: rows.length };
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(summary.inserted, 2);
  assert.equal(
    normalizeStudent(row(), "2026").source_hash,
    normalizeStudent(row(), "2026").source_hash,
  );
});
test("stream errors propagate and malformed rows cannot silently shift fields", async () => {
  await assert.rejects(
    processCsv(Readable.from([HEADERS.join(",") + "\nx,y"]), { batch: "2026" }),
  );
  await assert.rejects(
    processCsv(
      Readable.from(
        (async function* () {
          throw new Error("read failed");
        })(),
      ),
      { batch: "2026" },
    ),
    /read failed/,
  );
});
