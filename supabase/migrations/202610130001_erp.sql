-- Isolated schema: never modifies legacy public.students or career-platform tables.
CREATE SCHEMA IF NOT EXISTS erp;
REVOKE ALL ON SCHEMA erp FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsu_api') THEN
    CREATE ROLE dsu_api NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA erp TO dsu_api;

CREATE TABLE erp.students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enrollment_no text UNIQUE NOT NULL,
  full_name text NOT NULL, display_no text, course_name text, course_short_name text,
  department_name text, department_short_name text, admission_academic_year text, admission_year text,
  admission_type text, admission_quota text, current_semester text, exam_semester text,
  current_batch text, current_division text, status text, source_batch text NOT NULL CHECK (source_batch ~ '^20[0-9]{2}$'),
  source_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX students_department_batch ON erp.students(department_short_name,source_batch);
CREATE INDEX students_name ON erp.students(lower(full_name) text_pattern_ops);
CREATE TABLE erp.academics (
  student_id uuid PRIMARY KEY REFERENCES erp.students(id) ON DELETE CASCADE,
  attendance numeric CHECK(attendance BETWEEN 0 AND 100), achievements integer CHECK(achievements >= 0),
  cgpa numeric CHECK(cgpa BETWEEN 0 AND 10), percentage numeric CHECK(percentage BETWEEN 0 AND 100), sgpa numeric CHECK(sgpa BETWEEN 0 AND 10),
  current_backlog integer CHECK(current_backlog >= 0), total_backlog integer CHECK(total_backlog >= 0),
  fees_paid numeric(16,2) CHECK(fees_paid >= 0), fees_outstanding numeric(16,2), fee_category text
);
-- Contact/family fields are never included in directory responses or staff reads.
CREATE TABLE erp.contacts (student_id uuid PRIMARY KEY REFERENCES erp.students(id) ON DELETE CASCADE, details jsonb NOT NULL);
CREATE TABLE erp.memberships (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('admin','staff','student')),
  student_id uuid UNIQUE REFERENCES erp.students(id) ON DELETE SET NULL,
  CHECK(role <> 'student' OR student_id IS NOT NULL), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE erp.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source_batch text NOT NULL, summary jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE erp.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid, action text NOT NULL, resource_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created ON erp.audit_events(created_at);
CREATE FUNCTION erp.actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id',true),'')::uuid
$$;
CREATE FUNCTION erp.actor_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, erp AS $$
  SELECT role FROM erp.memberships WHERE user_id = erp.actor_id()
$$;
CREATE FUNCTION erp.actor_student() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, erp AS $$
  SELECT student_id FROM erp.memberships WHERE user_id = erp.actor_id()
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA erp FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA erp TO dsu_api;

ALTER TABLE erp.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.academics ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_read ON erp.students FOR SELECT TO dsu_api USING (erp.actor_role() IN ('admin','staff') OR id=erp.actor_student());
CREATE POLICY student_insert ON erp.students FOR INSERT TO dsu_api WITH CHECK (erp.actor_role()='admin');
CREATE POLICY student_update ON erp.students FOR UPDATE TO dsu_api USING (erp.actor_role()='admin') WITH CHECK (erp.actor_role()='admin');
CREATE POLICY academic_read ON erp.academics FOR SELECT TO dsu_api USING (erp.actor_role() IN ('admin','staff') OR student_id=erp.actor_student());
CREATE POLICY academic_insert ON erp.academics FOR INSERT TO dsu_api WITH CHECK (erp.actor_role()='admin');
CREATE POLICY academic_update ON erp.academics FOR UPDATE TO dsu_api USING (erp.actor_role()='admin') WITH CHECK (erp.actor_role()='admin');
CREATE POLICY contact_read ON erp.contacts FOR SELECT TO dsu_api USING (erp.actor_role()='admin' OR student_id=erp.actor_student());
CREATE POLICY contact_insert ON erp.contacts FOR INSERT TO dsu_api WITH CHECK (erp.actor_role()='admin');
CREATE POLICY contact_update ON erp.contacts FOR UPDATE TO dsu_api USING (erp.actor_role()='admin') WITH CHECK (erp.actor_role()='admin');
CREATE POLICY membership_read ON erp.memberships FOR SELECT TO dsu_api USING (user_id=erp.actor_id());
CREATE POLICY import_read ON erp.import_runs FOR SELECT TO dsu_api USING (erp.actor_role()='admin');
CREATE POLICY import_insert ON erp.import_runs FOR INSERT TO dsu_api WITH CHECK (erp.actor_role()='admin' AND actor_id=erp.actor_id());
CREATE POLICY audit_read ON erp.audit_events FOR SELECT TO dsu_api USING (erp.actor_role()='admin');
CREATE POLICY audit_insert ON erp.audit_events FOR INSERT TO dsu_api WITH CHECK (actor_id=erp.actor_id() AND erp.actor_role() IS NOT NULL);
GRANT SELECT, INSERT, UPDATE ON erp.students, erp.academics, erp.contacts TO dsu_api;
GRANT SELECT ON erp.memberships TO dsu_api;
GRANT SELECT, INSERT ON erp.import_runs, erp.audit_events TO dsu_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA erp TO dsu_api;
REVOKE ALL ON ALL TABLES IN SCHEMA erp FROM PUBLIC, anon, authenticated;
