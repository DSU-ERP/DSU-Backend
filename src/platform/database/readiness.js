// Objects the current code needs from the latest migrations. Catalog lookups
// work for the restricted runtime role even before it is granted schema usage.
// When a new migration adds something the API depends on, add it here.
const required = [
  ["table", "student", "profiles", null],
  ["table", "student", "registration_drafts", null],
  ["function", "student", "is_officer", null],
  ["function", "student", "registration_context", null],
  ["function", "student", "link_registration", null],
  ["function", "student", "link_by_enrollment", null],
  ["function", "erp", "can_import_students", null],
  ["function", "public", "dsu_friday_rename", null],
  ["column", "student", "attempts", "grading"],
  ["column", "placement", "drives", "published"],
  ["column", "placement", "drives", "min_attendance"],
  ["column", "placement", "drives", "openings"],
  ["column", "placement", "companies", "job_categories"],
  ["function", "student", "placement_record", null],
  ["function", "placement", "notify_eligible_students", null],
  ["column", "student", "attempts", "insights"],
  ["function", "student", "assessment_creator", null],
  ["column", "student", "documents", "meta"],
  ["table", "placement", "drive_intakes", null],
  ["column", "student", "interview_answers", "coaching"],
  ["column", "student", "interviews", "context"],
];

const missingSql = `
  SELECT r.kind, r.schema_name || '.' || r.object_name || coalesce('.' || r.column_name, '') AS name
  FROM jsonb_to_recordset($1::jsonb) AS r(kind text, schema_name text, object_name text, column_name text)
  WHERE NOT CASE r.kind
    WHEN 'table' THEN EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = r.schema_name AND c.relname = r.object_name)
    WHEN 'function' THEN EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = r.schema_name AND p.proname = r.object_name)
    ELSE EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = r.schema_name AND c.relname = r.object_name AND a.attname = r.column_name AND NOT a.attisdropped)
  END
  ORDER BY 2`;

export async function schemaStatus(pool) {
  const payload = JSON.stringify(
    required.map(([kind, schema_name, object_name, column_name]) => ({
      kind,
      schema_name,
      object_name,
      column_name,
    })),
  );
  const { rows } = await pool.query(missingSql, [payload]);
  const missing = rows.map((row) => `${row.kind} ${row.name}`);
  if (!missing.length) {
    // Also proves the runtime role can use the student schema.
    await pool.query("SELECT 1 FROM student.profiles LIMIT 0");
  }
  return { ready: missing.length === 0, missing };
}
