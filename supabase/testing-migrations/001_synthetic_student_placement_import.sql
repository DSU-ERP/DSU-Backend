-- This file is applied only by scripts/migrate-testing.js after its exact
-- project-target guard passes. It is intentionally outside supabase/migrations.
CREATE SCHEMA IF NOT EXISTS testing;
REVOKE ALL ON SCHEMA testing FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS testing.environment_marker (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO testing.environment_marker(key,value)
VALUES ('environment','dsu-synthetic-placement-testing-v1')
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;

CREATE TABLE IF NOT EXISTS testing.schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON testing.schema_migrations FROM PUBLIC, anon, authenticated;

-- Complete original rows are retained here. Application tables hold the fields
-- the ERP actively uses; this controlled staging record prevents data loss.
CREATE TABLE IF NOT EXISTS testing.synthetic_students (
  student_id uuid PRIMARY KEY REFERENCES erp.students(id) ON DELETE CASCADE,
  source_record text UNIQUE NOT NULL,
  enrollment_no text UNIQUE NOT NULL,
  source_hash text NOT NULL,
  source_data jsonb NOT NULL CHECK (jsonb_typeof(source_data)='object'),
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS testing_synthetic_students_usn ON testing.synthetic_students(enrollment_no);

CREATE TABLE IF NOT EXISTS testing.synthetic_drives (
  source_key text PRIMARY KEY,
  drive_id uuid UNIQUE NOT NULL REFERENCES placement.drives(id) ON DELETE CASCADE,
  company_name text NOT NULL,
  offer_sequence integer NOT NULL CHECK(offer_sequence BETWEEN 1 AND 6),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS testing.synthetic_offer_metadata (
  offer_id uuid PRIMARY KEY REFERENCES placement.offers(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  source_record text NOT NULL,
  offer_sequence integer NOT NULL CHECK(offer_sequence BETWEEN 1 AND 6),
  source_data jsonb NOT NULL CHECK(jsonb_typeof(source_data)='object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_record,offer_sequence)
);
CREATE INDEX IF NOT EXISTS testing_synthetic_offer_student ON testing.synthetic_offer_metadata(student_id);

CREATE TABLE IF NOT EXISTS testing.synthetic_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file text NOT NULL,
  source_sha256 text NOT NULL,
  summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON ALL TABLES IN SCHEMA testing FROM PUBLIC, anon, authenticated;
