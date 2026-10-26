import { createPool } from "../src/integrations/supabase/db.js";
import { assertTestingMarker, assertTestingTarget } from "../src/platform/testing-guard.js";

assertTestingTarget();
const env = { ...process.env, DATABASE_CA_PATH: process.env.TESTING_DATABASE_CA_PATH || process.env.DATABASE_CA_PATH, DATABASE_POOL_MAX: "1" };
const pool = createPool(process.env.TESTING_DATABASE_ADMIN_URL, env);
let client;
try {
  client = await pool.connect();
  await assertTestingMarker(client);
  const { rows } = await client.query(`
    SELECT
      count(*)::int AS students,
      count(DISTINCT t.enrollment_no)::int AS distinct_usns,
      min((SELECT count(*) FROM jsonb_object_keys(t.source_data)))::int AS minimum_preserved_source_fields,
      max((SELECT count(*) FROM jsonb_object_keys(t.source_data)))::int AS maximum_preserved_source_fields,
      count(*) FILTER (WHERE erp.cgpa_category(a.cgpa)='advanced')::int AS advanced,
      count(*) FILTER (WHERE erp.cgpa_category(a.cgpa)='medium')::int AS medium,
      count(*) FILTER (WHERE erp.cgpa_category(a.cgpa)='needs-improvement')::int AS needs_improvement,
      count(*) FILTER (WHERE a.cgpa IS NULL)::int AS unclassified,
      count(*) FILTER (WHERE ((t.source_data->>'placement_eligible')='YES') IS DISTINCT FROM (a.cgpa>=6.75))::int AS source_eligibility_policy_differences
    FROM testing.synthetic_students t
    JOIN erp.students s ON s.id=t.student_id
    LEFT JOIN erp.academics a ON a.student_id=s.id
  `);
  const offers = await client.query("SELECT count(*)::int AS normalized_offers, count(DISTINCT source_record)::int AS students_with_offers FROM testing.synthetic_offer_metadata");
  const runs = await client.query("SELECT count(*)::int AS committed_import_runs FROM testing.synthetic_import_runs");
  const report = { ...rows[0], ...offers.rows[0], ...runs.rows[0] };
  const valid = report.students === 100 && report.distinct_usns === 100 && report.minimum_preserved_source_fields === 80 && report.maximum_preserved_source_fields === 80 && report.normalized_offers === 93 && report.advanced + report.medium + report.needs_improvement === report.students;
  console.log(JSON.stringify({ valid, report }, null, 2));
  if (!valid) process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
