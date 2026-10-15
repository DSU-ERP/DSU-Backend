import { parse } from "csv-parse";
import { createHash } from "node:crypto";
import { validCgpa, compareDecimal } from "../analytics/categoryRules.js";

export const HEADERS =
  "enrollmentNo,studentDisplayNo,studentFullName,courseName,courseShortName,departmentName,departmentShortName,admissionAcademicYearName,admissionYearName,admissionTypeName,admissionQuotaName,currentSemester,examSemester,currentBatch,currentDivision,studentStatusName,email,phoneStudent1,whatsappNo,gender,motherTongueLanguageName,region,presentCity,presentDistrictName,presentStateName,presentCountryName,fatherName,motherName,fatherMobile,motherMobile,currentTermAttenadance,achievementTotal,cgpa,cumulativePCT,lastSGPA,currentBacklog,totalBacklog,feesPaidAmount,feesOutstandingAmount,feeCategoryName".split(
    ",",
  );
const text = (value) => {
  const s = String(value ?? "")
    .normalize("NFKC")
    .trim();
  return !s || /^(null|n\/a|na|-)$/i.test(s) ? null : s;
};
function number(
  value,
  field,
  max = Number.MAX_SAFE_INTEGER,
  integer = false,
  min = 0,
) {
  const clean = text(value);
  if (clean === null) return null;
  if (!/^-?\d+(\.\d+)?$/.test(clean)) throw new Error(`Invalid ${field}`);
  const n = Number(clean);
  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  )
    throw new Error(`Out of range ${field}`);
  return n;
}
export function normalizeStudent(row, sourceBatch) {
  const enrollment = text(row.enrollmentNo)?.toUpperCase();
  const fullName = text(row.studentFullName);
  if (!enrollment || !/^[A-Z0-9][A-Z0-9/._-]{1,63}$/.test(enrollment))
    throw new Error("Missing or invalid enrollmentNo");
  if (!fullName || fullName.length > 200)
    throw new Error("Missing or invalid studentFullName");
  for (const key of HEADERS)
    if (String(row[key] ?? "").length > 500) throw new Error(`Too long ${key}`);
  const email = text(row.email)?.toLowerCase() ?? null;
  const cgpaText = text(row.cgpa);
  if (cgpaText !== null && !validCgpa(cgpaText))
    throw new Error("Invalid cgpa");
  // Keep existing hashes for ordinary decimals; retain a string when converting
  // to a JS number would change the value sent to PostgreSQL numeric.
  const cgpa =
    cgpaText === null
      ? null
      : compareDecimal(String(Number(cgpaText)), cgpaText) === 0
        ? Number(cgpaText)
        : cgpaText;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Invalid email");
  const record = {
    enrollment_no: enrollment,
    full_name: fullName,
    display_no: text(row.studentDisplayNo),
    course_name: text(row.courseName),
    course_short_name: text(row.courseShortName),
    department_name: text(row.departmentName),
    department_short_name: text(row.departmentShortName),
    admission_academic_year: text(row.admissionAcademicYearName),
    admission_year: text(row.admissionYearName),
    admission_type: text(row.admissionTypeName),
    admission_quota: text(row.admissionQuotaName),
    current_semester: text(row.currentSemester),
    exam_semester: text(row.examSemester),
    current_batch: text(row.currentBatch),
    current_division: text(row.currentDivision),
    status: text(row.studentStatusName),
    source_batch: sourceBatch,
    academic: {
      attendance: number(
        row.currentTermAttenadance,
        "currentTermAttenadance",
        100,
      ),
      achievements: number(
        row.achievementTotal,
        "achievementTotal",
        100000,
        true,
      ),
      cgpa,
      percentage: number(row.cumulativePCT, "cumulativePCT", 100),
      sgpa: number(row.lastSGPA, "lastSGPA", 10),
      current_backlog: number(row.currentBacklog, "currentBacklog", 1000, true),
      total_backlog: number(row.totalBacklog, "totalBacklog", 1000, true),
      fees_paid: number(row.feesPaidAmount, "feesPaidAmount", 1e10),
      fees_outstanding: number(
        row.feesOutstandingAmount,
        "feesOutstandingAmount",
        1e10,
        false,
        -1e10,
      ),
      fee_category: text(row.feeCategoryName),
    },
    contact: Object.fromEntries(
      [
        "phoneStudent1",
        "whatsappNo",
        "gender",
        "motherTongueLanguageName",
        "region",
        "presentCity",
        "presentDistrictName",
        "presentStateName",
        "presentCountryName",
        "fatherName",
        "motherName",
        "fatherMobile",
        "motherMobile",
      ].map((key) => [key, text(row[key])]),
    ),
  };
  record.contact.email = email;
  record.source_hash = createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex");
  return record;
}

export async function processCsv(
  input,
  {
    batch,
    consume = async () => ({}),
    batchSize = 250,
    maxRows = 100000,
    validateOnly = false,
  } = {},
) {
  if (!/^20\d{2}$/.test(batch ?? ""))
    throw new Error("A four-digit source batch is required");
  const summary = {
    total: 0,
    valid: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    issueCounts: {},
    issues: [],
    validateOnly,
  };
  const seen = new Map();
  let pending = [];
  const report = (row, reason) => {
    summary.issueCounts[reason] = (summary.issueCounts[reason] || 0) + 1;
    if (summary.issues.length < 100) summary.issues.push({ row, reason });
  };
  const flush = async () => {
    if (!pending.length) return;
    if (!validateOnly) {
      const result = await consume(pending);
      for (const key of ["inserted", "updated", "unchanged"])
        summary[key] += result[key] || 0;
    }
    pending = [];
  };
  const parser = input.pipe(
    parse({
      bom: true,
      columns: (columns) => {
        if (
          new Set(columns).size !== columns.length ||
          columns.length !== HEADERS.length ||
          HEADERS.some((h) => !columns.includes(h))
        )
          throw new Error(
            "CSV headers do not match the approved 40-column student export",
          );
        return columns;
      },
      skip_empty_lines: true,
      max_record_size: 32768,
    }),
  );
  // Preserve file/stream failures rather than leaving the parser waiting forever.
  input.on("error", (error) => parser.destroy(error));
  for await (const row of parser) {
    summary.total++;
    if (summary.total > maxRows) throw new Error("CSV exceeds row limit");
    let record;
    try {
      record = normalizeStudent(row, batch);
    } catch (e) {
      summary.failed++;
      report(summary.total + 1, e.message);
      continue;
    }
    if (seen.has(record.enrollment_no)) {
      if (seen.get(record.enrollment_no) === record.source_hash) {
        summary.skipped++;
        report(summary.total + 1, "Identical duplicate enrollment in file");
      } else {
        summary.failed++;
        report(
          summary.total + 1,
          "Conflicting duplicate enrollment; first valid row retained",
        );
      }
      continue;
    }
    seen.set(record.enrollment_no, record.source_hash);
    summary.valid++;
    pending.push(record);
    if (pending.length >= batchSize) await flush();
  }
  await flush();
  if (!summary.total) throw new Error("CSV contains no student rows");
  return summary;
}
