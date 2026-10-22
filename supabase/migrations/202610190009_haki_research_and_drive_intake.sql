-- Observation Haki research and officer drive-PDF intake. Additive only.

-- 1. Extraction metadata for uploaded documents (page count, characters,
--    truncation and the scanned-PDF heuristic). Older rows keep '{}'.
ALTER TABLE student.documents
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object');

-- 2. Drive notices imported by placement officers. Only the extracted text,
--    file metadata and the AI field suggestions are kept for review and audit;
--    the PDF binary is not stored and no file links are created. Officers
--    review and save the drive themselves through drive.save.
CREATE TABLE placement.drive_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 100),
  chars integer NOT NULL CHECK (chars >= 0),
  truncated boolean NOT NULL DEFAULT false,
  low_text boolean NOT NULL DEFAULT false,
  content text NOT NULL CHECK (length(content) <= 80000),
  extracted jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extracted) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX placement_drive_intakes_date ON placement.drive_intakes(created_at DESC);
ALTER TABLE placement.drive_intakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY drive_intake_officer_read ON placement.drive_intakes FOR SELECT TO dsu_api
  USING (student.is_officer());
CREATE POLICY drive_intake_officer_create ON placement.drive_intakes FOR INSERT TO dsu_api
  WITH CHECK (student.is_officer() AND created_by = erp.actor_id());
REVOKE ALL ON placement.drive_intakes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON placement.drive_intakes TO dsu_api;
NOTIFY pgrst, 'reload schema';
