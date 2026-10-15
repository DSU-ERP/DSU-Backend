import { processCsv } from "./csv.js";

const studentFields = [
  "enrollment_no",
  "full_name",
  "display_no",
  "course_name",
  "course_short_name",
  "department_name",
  "department_short_name",
  "admission_academic_year",
  "admission_year",
  "admission_type",
  "admission_quota",
  "current_semester",
  "exam_semester",
  "current_batch",
  "current_division",
  "status",
  "source_batch",
  "source_hash",
];
const academicFields = [
  "attendance",
  "achievements",
  "cgpa",
  "percentage",
  "sgpa",
  "current_backlog",
  "total_backlog",
  "fees_paid",
  "fees_outstanding",
  "fee_category",
];

export async function upsertBatch(client, records) {
  const fields = studentFields.join(",");
  const update = studentFields
    .filter((f) => f !== "enrollment_no")
    .map((f) => `${f}=EXCLUDED.${f}`)
    .join(",");
  const result = await client.query(
    `INSERT INTO erp.students (${fields})
    SELECT ${fields} FROM jsonb_populate_recordset(NULL::erp.students, $1::jsonb)
    ON CONFLICT (enrollment_no) DO UPDATE SET ${update},updated_at=now()
    WHERE erp.students.source_hash IS DISTINCT FROM EXCLUDED.source_hash
    RETURNING id,enrollment_no,(xmax=0) AS inserted`,
    [JSON.stringify(records)],
  );
  const byEnrollment = new Map(records.map((r) => [r.enrollment_no, r]));
  if (result.rows.length) {
    const academic = result.rows.map((r) => ({
      student_id: r.id,
      ...byEnrollment.get(r.enrollment_no).academic,
    }));
    const contacts = result.rows.map((r) => ({
      student_id: r.id,
      details: byEnrollment.get(r.enrollment_no).contact,
    }));
    await client.query(
      `INSERT INTO erp.academics SELECT * FROM jsonb_populate_recordset(NULL::erp.academics,$1::jsonb)
      ON CONFLICT (student_id) DO UPDATE SET ${academicFields.map((f) => `${f}=EXCLUDED.${f}`).join(",")}`,
      [JSON.stringify(academic)],
    );
    await client.query(
      `INSERT INTO erp.contacts SELECT * FROM jsonb_populate_recordset(NULL::erp.contacts,$1::jsonb)
      ON CONFLICT (student_id) DO UPDATE SET details=EXCLUDED.details`,
      [JSON.stringify(contacts)],
    );
  }
  const inserted = result.rows.filter((r) => r.inserted).length;
  return {
    inserted,
    updated: result.rows.length - inserted,
    unchanged: records.length - result.rows.length,
  };
}

// Caller owns transaction: a malformed file/DB error rolls back every batch.
export async function importStudents(client, input, batch, actorId = null) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('erp.student-import'))",
  );
  const summary = await processCsv(input, {
    batch,
    consume: (records) => upsertBatch(client, records),
  });
  const { rows } = await client.query(
    "INSERT INTO erp.import_runs (actor_id,source_batch,summary) VALUES ($1,$2,$3) RETURNING id",
    [actorId, batch, summary],
  );
  await client.query(
    "INSERT INTO erp.audit_events (actor_id,action,resource_id) VALUES ($1,$2,$3)",
    [actorId, "students.import", rows[0].id],
  );
  return { id: rows[0].id, ...summary };
}
