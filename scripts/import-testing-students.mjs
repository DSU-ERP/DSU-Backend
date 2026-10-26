// Synthetic-workbook importer. It only accepts the explicitly approved testing
// Supabase project and preserves the complete original source row in the
// testing schema. Use --apply to commit; without it every database change rolls
// back after validation.
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import XLSX from "xlsx";
import { createPool } from "../src/integrations/supabase/db.js";
import { assertTestingMarker, assertTestingTarget } from "../src/platform/testing-guard.js";

const BASE_HEADERS = [
  "synthetic_record", "student_id", "usn", "full_name", "student_email", "student_contact", "date_of_birth", "age", "sex",
  "department", "branch", "degree", "batch", "graduation_year", "current_semester", "admission_mode", "tenth_percentage",
  "twelfth_percentage", "btech_percentage", "cgpa", "cgpa_category", "active_backlogs", "registered_for_placements",
  "placement_eligible", "higher_education", "placed", "offer_count", "max_offer_ctc_lpa", "min_offer_ctc_lpa",
  "median_offer_ctc_lpa", "average_offer_ctc_lpa", "highest_stipend_inr_per_month", "github_username", "github_profile_url",
  "leetcode_profile_url", "hackerrank_profile_url", "linkedin_profile_url", "huggingface_profile_url", "kaggle_profile_url",
  "profile_onboarding_status", "resume_submitted", "skills", "target_role", "certification_count",
];
const OFFER_HEADERS = Array.from({ length: 6 }, (_, index) => {
  const n = index + 1;
  return [
    `offer_${n}_company`, `offer_${n}_ctc_lpa`, `offer_${n}_stipend_inr_per_month`,
    `offer_${n}_soft_offer_letter`, `offer_${n}_internship_offer_letter`, `offer_${n}_status`,
  ];
}).flat();
const EXPECTED_HEADERS = [...BASE_HEADERS, ...OFFER_HEADERS];
const CATEGORY = (value) => value >= 8.5 ? "advanced" : value >= 6.75 ? "medium" : "needs-improvement";
const SOURCE_CATEGORY = { advanced: "Advanced", medium: "Medium", "needs-improvement": "Needs Improvement" };
const OFFER_STATUS = { Accepted: "accepted", Received: "offered", Pending: "offered" };
const REGISTRATION_STATUS = { Accepted: "placed", Received: "selected", Pending: "in-progress" };

const trim = (value) => value == null ? "" : String(value).trim();
const finite = (value, label, { min = -Infinity, max = Infinity, integer = false } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number)))
    throw new Error(`${label} must be a ${integer ? "whole " : ""}number between ${min} and ${max}`);
  return number;
};
const yesNo = (value, label) => {
  const parsed = trim(value).toUpperCase();
  if (parsed !== "YES" && parsed !== "NO") throw new Error(`${label} must be YES or NO`);
  return parsed === "YES";
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicUrl = (value, label) => {
  const text = trim(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch { throw new Error(`${label} must be an http(s) URL when provided`); }
};

function usage() {
  console.error("Usage: npm run db:seed:testing -- <DSU_100_Synthetic_Student_Placement_Records.xlsx> [--apply]");
  process.exit(1);
}

function validateWorkbook(file) {
  const workbook = XLSX.readFile(file, { cellDates: false, raw: false });
  if (workbook.SheetNames.length !== 1) throw new Error("Workbook must contain exactly one student-records worksheet");
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: false });
  const headers = Object.keys(rows[0] || {});
  const missing = EXPECTED_HEADERS.filter((header) => !headers.includes(header));
  const unknown = headers.filter((header) => !EXPECTED_HEADERS.includes(header));
  if (missing.length || unknown.length || headers.length !== EXPECTED_HEADERS.length)
    throw new Error(`Workbook must preserve exactly the 80 supported columns. Missing: ${missing.join(",") || "none"}; unexpected: ${unknown.join(",") || "none"}`);
  if (rows.length !== 100) throw new Error(`Expected 100 synthetic students; received ${rows.length}`);

  const seen = new Set();
  const sourceEligibilityMismatches = [];
  const normalized = rows.map((raw, offset) => {
    const line = offset + 2;
    const usn = trim(raw.usn).toUpperCase();
    if (!usn || !/^ENG\d{2}[A-Z]{2}\d{4}$/i.test(usn)) throw new Error(`Row ${line}: invalid USN`);
    if (seen.has(usn)) throw new Error(`Row ${line}: duplicate USN ${usn}`);
    seen.add(usn);
    const fullName = trim(raw.full_name);
    if (!fullName) throw new Error(`Row ${line}: full_name is required`);
    const email = trim(raw.student_email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Row ${line}: invalid student_email`);
    const contact = trim(raw.student_contact);
    if (!/^\d{10}$/.test(contact)) throw new Error(`Row ${line}: student_contact must contain 10 digits`);
    const cgpa = finite(raw.cgpa, `Row ${line}: cgpa`, { min: 0, max: 10 });
    const sgpa = null; // The supplied workbook has no SGPA column; do not fabricate one.
    const sourceCategory = trim(raw.cgpa_category);
    const category = CATEGORY(cgpa);
    if (sourceCategory !== SOURCE_CATEGORY[category])
      throw new Error(`Row ${line}: cgpa_category does not match precise CGPA ${cgpa}`);
    const backlogs = finite(raw.active_backlogs, `Row ${line}: active_backlogs`, { min: 0, max: 100, integer: true });
    const declaredOfferCount = finite(raw.offer_count, `Row ${line}: offer_count`, { min: 0, max: 6, integer: true });
    const graduationYear = finite(raw.graduation_year, `Row ${line}: graduation_year`, { min: 2000, max: 2100, integer: true });
    const batch = trim(raw.batch);
    if (!/^20\d{2}-20\d{2}$/.test(batch)) throw new Error(`Row ${line}: batch must have format YYYY-YYYY`);
    const offers = [];
    for (let n = 1; n <= 6; n++) {
      const company = trim(raw[`offer_${n}_company`]);
      const fields = OFFER_HEADERS.filter((field) => field.startsWith(`offer_${n}_`));
      const populated = fields.some((field) => trim(raw[field]));
      if (!company && populated) throw new Error(`Row ${line}: offer_${n} has fields but no company`);
      if (!company) continue;
      const ctc = finite(raw[`offer_${n}_ctc_lpa`], `Row ${line}: offer_${n}_ctc_lpa`, { min: 0, max: 10000 });
      const stipendText = trim(raw[`offer_${n}_stipend_inr_per_month`]);
      const stipend = stipendText ? finite(stipendText, `Row ${line}: offer_${n}_stipend_inr_per_month`, { min: 0, max: 10_000_000 }) : null;
      const status = trim(raw[`offer_${n}_status`]);
      if (!OFFER_STATUS[status]) throw new Error(`Row ${line}: offer_${n}_status is unsupported`);
      offers.push({ sequence: n, company, ctc, stipend, status, source: Object.fromEntries(fields.map((field) => [field, raw[field]])) });
    }
    if (offers.length !== declaredOfferCount) throw new Error(`Row ${line}: offer_count does not match populated offers`);
    const sourceEligible = yesNo(raw.placement_eligible, `Row ${line}: placement_eligible`);
    const policyEligible = cgpa >= 6.75;
    if (sourceEligible !== policyEligible) sourceEligibilityMismatches.push(usn);
    return {
      line, raw, usn, fullName, email, contact, cgpa, sgpa, category, backlogs, graduationYear, batch, offers,
      sourceEligible, policyEligible,
      department: trim(raw.department), branch: trim(raw.branch), degree: trim(raw.degree),
      semester: trim(raw.current_semester), admissionMode: trim(raw.admission_mode),
      tenth: finite(raw.tenth_percentage, `Row ${line}: tenth_percentage`, { min: 0, max: 100 }),
      twelfth: finite(raw.twelfth_percentage, `Row ${line}: twelfth_percentage`, { min: 0, max: 100 }),
      btech: finite(raw.btech_percentage, `Row ${line}: btech_percentage`, { min: 0, max: 100 }),
      github: trim(raw.github_profile_url), linkedin: trim(raw.linkedin_profile_url),
      sourceHash: hash(JSON.stringify(EXPECTED_HEADERS.map((header) => [header, raw[header]]))),
    };
  });
  return { rows: normalized, sourceEligibilityMismatches };
}

async function importRows(client, records) {
  const studentInput = records.map((record) => ({
    usn: record.usn, full_name: record.fullName, degree: record.degree, department: record.department, branch: record.branch,
    batch: record.batch, admission_year: record.batch.slice(0, 4), admission_mode: record.admissionMode, semester: record.semester,
    graduation_year: String(record.graduationYear), source_hash: record.sourceHash, cgpa: record.cgpa, percentage: record.btech,
    backlogs: record.backlogs, email: record.email, phone: record.contact, raw: record.raw,
  }));
  const upserted = await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(usn text,full_name text,degree text,department text,branch text,batch text,admission_year text,admission_mode text,semester text,graduation_year text,source_hash text,cgpa numeric,percentage numeric,backlogs integer,email text,phone text,raw jsonb))
     INSERT INTO erp.students(enrollment_no,full_name,display_no,course_name,course_short_name,department_name,department_short_name,admission_academic_year,admission_year,admission_type,admission_quota,current_semester,exam_semester,current_batch,status,source_batch,source_hash)
     SELECT usn,full_name,usn,degree,degree,department,branch,batch,admission_year,'Regular',admission_mode,semester,semester,batch,'Active',graduation_year,source_hash FROM input
     ON CONFLICT(enrollment_no) DO UPDATE SET full_name=EXCLUDED.full_name,course_name=EXCLUDED.course_name,course_short_name=EXCLUDED.course_short_name,department_name=EXCLUDED.department_name,department_short_name=EXCLUDED.department_short_name,admission_academic_year=EXCLUDED.admission_academic_year,admission_year=EXCLUDED.admission_year,admission_quota=EXCLUDED.admission_quota,current_semester=EXCLUDED.current_semester,exam_semester=EXCLUDED.exam_semester,current_batch=EXCLUDED.current_batch,status=EXCLUDED.status,source_batch=EXCLUDED.source_batch,source_hash=EXCLUDED.source_hash,updated_at=now()
     RETURNING id,enrollment_no`, [JSON.stringify(studentInput)],
  );
  const studentIds = new Map(upserted.rows.map((row) => [row.enrollment_no, row.id]));
  if (studentIds.size !== records.length) throw new Error("Student upsert did not return every synthetic student");
  for (const record of records) record.studentId = studentIds.get(record.usn);
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(usn text,cgpa numeric,percentage numeric,backlogs integer))
     INSERT INTO erp.academics(student_id,attendance,achievements,cgpa,percentage,sgpa,current_backlog,total_backlog)
     SELECT s.id,NULL,0,i.cgpa,i.percentage,NULL,i.backlogs,i.backlogs FROM input i JOIN erp.students s ON s.enrollment_no=i.usn
     ON CONFLICT(student_id) DO UPDATE SET cgpa=EXCLUDED.cgpa,percentage=EXCLUDED.percentage,sgpa=EXCLUDED.sgpa,current_backlog=EXCLUDED.current_backlog,total_backlog=EXCLUDED.total_backlog`, [JSON.stringify(studentInput)],
  );
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(usn text,email text,phone text,raw jsonb))
     INSERT INTO erp.contacts(student_id,details)
     SELECT s.id,jsonb_build_object('email',i.email,'phone',i.phone,'date_of_birth',i.raw->'date_of_birth','sex',i.raw->'sex','source_testing_record',true) FROM input i JOIN erp.students s ON s.enrollment_no=i.usn
     ON CONFLICT(student_id) DO UPDATE SET details=EXCLUDED.details`, [JSON.stringify(studentInput)],
  );
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(usn text,source_hash text,raw jsonb))
     INSERT INTO testing.synthetic_students(student_id,source_record,enrollment_no,source_hash,source_data)
     SELECT s.id,i.usn,i.usn,i.source_hash,i.raw FROM input i JOIN erp.students s ON s.enrollment_no=i.usn
     ON CONFLICT(student_id) DO UPDATE SET source_record=EXCLUDED.source_record,enrollment_no=EXCLUDED.enrollment_no,source_hash=EXCLUDED.source_hash,source_data=EXCLUDED.source_data,imported_at=now()`, [JSON.stringify(studentInput)],
  );
  const ids = [...studentIds.values()];
  // Only records created by this importer and linked to testing drives are
  // removed before re-import. Normal placement data is never in this query.
  await client.query(
    `DELETE FROM placement.registrations r USING testing.synthetic_drives d
     WHERE r.drive_id=d.drive_id AND r.student_id=ANY($1::uuid[])`, [ids],
  );
  const offerInput = records.flatMap((record) => record.offers.map((offer) => ({
    student_id: record.studentId, usn: record.usn, sequence: offer.sequence, company: offer.company, company_key: offer.company.toLowerCase(),
    drive_key: hash(`synthetic-offer-drive:${offer.company.toLowerCase()}:${offer.sequence}`), ctc: offer.ctc, stipend: offer.stipend,
    offer_status: OFFER_STATUS[offer.status], registration_status: REGISTRATION_STATUS[offer.status], batch: record.batch,
    graduation_year: String(record.graduationYear), branch: record.branch, source: offer.source,
  })));
  const companyInput = [...new Map(offerInput.map((offer) => [offer.company_key, { name: offer.company }])).values()];
  const companies = await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(name text))
     INSERT INTO placement.companies(name,active) SELECT name,true FROM input
     ON CONFLICT (lower(btrim(name))) DO UPDATE SET active=true,updated_at=now() RETURNING id,name`, [JSON.stringify(companyInput)],
  );
  const companyIds = new Map(companies.rows.map((row) => [row.name.toLowerCase(), row.id]));
  if (companyIds.size !== companyInput.length) throw new Error("Company upsert did not return every imported company");
  const existing = await client.query("SELECT source_key,drive_id FROM testing.synthetic_drives WHERE source_key=ANY($1::text[])", [offerInput.map((offer) => offer.drive_key)]);
  const oldDriveIds = new Map(existing.rows.map((row) => [row.source_key, row.drive_id]));
  const drives = [...new Map(offerInput.map((offer) => [offer.drive_key, {
    source_key: offer.drive_key, id: oldDriveIds.get(offer.drive_key) || randomUUID(), is_new: !oldDriveIds.has(offer.drive_key),
    company_id: companyIds.get(offer.company_key), company_name: offer.company, offer_sequence: offer.sequence, ctc: offer.ctc,
    academic_year: offer.batch, batch: offer.graduation_year, branch: offer.branch,
  }])).values()];
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,is_new boolean,company_id uuid,ctc numeric,academic_year text,batch text,branch text,company_name text,offer_sequence integer))
     UPDATE placement.drives d SET company_id=i.company_id,title=i.company_name||' — imported offer '||i.offer_sequence,description='Synthetic data import; not a live drive.',package_lpa=i.ctc,academic_year=i.academic_year,batch=i.batch,min_cgpa=0,max_backlogs=100,branches=ARRAY[i.branch],rounds=ARRAY['Imported placement record'],status='completed',published=false,updated_at=now(),revision=d.revision+1 FROM input i WHERE NOT i.is_new AND d.id=i.id`, [JSON.stringify(drives)],
  );
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,is_new boolean,company_id uuid,ctc numeric,academic_year text,batch text,branch text,company_name text,offer_sequence integer))
     INSERT INTO placement.drives(id,company_id,title,description,package_lpa,academic_year,batch,min_cgpa,max_backlogs,branches,rounds,status,published)
     SELECT id,company_id,company_name||' — imported offer '||offer_sequence,'Synthetic data import; not a live drive.',ctc,academic_year,batch,0,100,ARRAY[branch],ARRAY['Imported placement record'],'completed',false FROM input WHERE is_new`, [JSON.stringify(drives)],
  );
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(source_key text,id uuid,company_name text,offer_sequence integer))
     INSERT INTO testing.synthetic_drives(source_key,drive_id,company_name,offer_sequence) SELECT source_key,id,company_name,offer_sequence FROM input
     ON CONFLICT(source_key) DO UPDATE SET drive_id=EXCLUDED.drive_id,company_name=EXCLUDED.company_name,offer_sequence=EXCLUDED.offer_sequence,imported_at=now()`, [JSON.stringify(drives)],
  );
  const driveIds = new Map(drives.map((drive) => [drive.source_key, drive.id]));
  const placementRows = offerInput.map((offer) => ({ ...offer, drive_id: driveIds.get(offer.drive_key), registration_id: randomUUID(), offer_id: randomUUID() }));
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(registration_id uuid,drive_id uuid,student_id uuid,registration_status text))
     INSERT INTO placement.registrations(id,drive_id,student_id,status,current_round) SELECT registration_id,drive_id,student_id,registration_status,1 FROM input`, [JSON.stringify(placementRows)],
  );
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(offer_id uuid,registration_id uuid,ctc numeric,offer_status text))
     INSERT INTO placement.offers(id,registration_id,package_lpa,status) SELECT offer_id,registration_id,ctc,offer_status FROM input`, [JSON.stringify(placementRows)],
  );
  await client.query(
    `WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(offer_id uuid,student_id uuid,usn text,sequence integer,source jsonb))
     INSERT INTO testing.synthetic_offer_metadata(offer_id,student_id,source_record,offer_sequence,source_data) SELECT offer_id,student_id,usn,sequence,source FROM input`, [JSON.stringify(placementRows)],
  );
  return { studentCount: records.length, offerCount: offerInput.length };
}

const file = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
if (!file) usage();
assertTestingTarget();
const sourcePath = resolve(file);
const source = await readFile(sourcePath);
const { rows, sourceEligibilityMismatches } = validateWorkbook(sourcePath);
const apply = process.argv.includes("--apply");
const env = {
  ...process.env,
  DATABASE_CA_PATH: process.env.TESTING_DATABASE_CA_PATH || process.env.DATABASE_CA_PATH,
  DATABASE_POOL_MAX: "1",
  DATABASE_QUERY_TIMEOUT_MS: process.env.TESTING_DATABASE_QUERY_TIMEOUT_MS || "120000",
  DATABASE_STATEMENT_TIMEOUT_MS: process.env.TESTING_DATABASE_STATEMENT_TIMEOUT_MS || "120000",
};
const pool = createPool(process.env.TESTING_DATABASE_ADMIN_URL, env);
let client;
try {
  client = await pool.connect();
  await assertTestingMarker(client);
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('testing.synthetic-student-import'))");
  const saved = await importRows(client, rows);
  const { rows: reconciliation } = await client.query(
    `SELECT count(*)::int AS total, count(a.cgpa)::int AS valid_cgpa,
      count(*) FILTER (WHERE erp.cgpa_category(a.cgpa)='advanced')::int AS advanced,
      count(*) FILTER (WHERE erp.cgpa_category(a.cgpa)='medium')::int AS medium,
      count(*) FILTER (WHERE erp.cgpa_category(a.cgpa)='needs-improvement')::int AS needs_improvement
     FROM testing.synthetic_students t JOIN erp.students s ON s.id=t.student_id LEFT JOIN erp.academics a ON a.student_id=s.id`,
  );
  const summary = { source_file: basename(sourcePath), source_sha256: hash(source), students: saved.studentCount, offers: saved.offerCount,
    source_eligibility_mismatches: sourceEligibilityMismatches.length, reconciliation: reconciliation[0] };
  const result = reconciliation[0];
  if (result.advanced + result.medium + result.needs_improvement !== result.valid_cgpa || result.valid_cgpa !== result.total)
    throw new Error("Imported CGPA categories do not reconcile to the synthetic student cohort");
  if (apply) {
    await client.query("INSERT INTO testing.synthetic_import_runs(source_file,source_sha256,summary) VALUES($1,$2,$3::jsonb)", [summary.source_file, summary.source_sha256, JSON.stringify(summary)]);
    await client.query("COMMIT");
  } else await client.query("ROLLBACK");
  console.log(JSON.stringify({ valid: true, saved: apply, ...summary }, null, 2));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => {});
  console.error(`Synthetic import failed: ${error.code || error.message}`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
