-- Company portal (docs/COMPANY-PORTAL.md).
--
-- Recruiting companies get invite-only accounts. A company submits a drive
-- REQUEST; nothing it writes reaches students, officer analytics or FRIDAY
-- until a placement officer approves it, which creates (or updates) the real
-- placement.drives row and fixes the drive's audience: rule filters plus
-- officer-picked additions and removals. Applicants are shared with the
-- company only after the officer releases them, and only students who
-- consented when applying.
--
-- Isolation: every company read and write goes through SECURITY DEFINER
-- functions owned by dsu_company, a no-login role whose row-level policies
-- only ever match the signed-in member's own company. Company A cannot read
-- company B's requests, drives, applicants or files, by function or by id.

-- ---------------------------------------------------------------- roles
CREATE SCHEMA company;
REVOKE ALL ON SCHEMA company FROM PUBLIC,anon,authenticated;
CREATE SCHEMA files;
REVOKE ALL ON SCHEMA files FROM PUBLIC,anon,authenticated;
CREATE ROLE dsu_company NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
DO $$ BEGIN EXECUTE format('GRANT dsu_company TO %I',current_user); END $$;
GRANT USAGE ON SCHEMA company,placement,erp,files TO dsu_company;
GRANT USAGE ON SCHEMA company,files TO dsu_api,dsu_placement;
GRANT EXECUTE ON FUNCTION erp.actor_id(),placement.actor(),placement.package_rank(numeric),placement.package_category(numeric) TO dsu_company;

-- ---------------------------------------------------------------- accounts
CREATE TABLE company.members(
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES placement.companies(id) ON DELETE CASCADE,
  email text NOT NULL CHECK(length(email)<=320),
  name text CHECK(length(name)<=200),
  active boolean NOT NULL DEFAULT true,
  invite_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, revoked_by uuid
);
CREATE INDEX company_members_company ON company.members(company_id);
CREATE TABLE company.invites(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES placement.companies(id) ON DELETE CASCADE,
  email text NOT NULL CHECK(email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND length(email)<=320),
  name text CHECK(length(name)<=200),
  -- Only the SHA-256 of the one-time token is stored; the token itself is shown once.
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL, accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX company_invites_company ON company.invites(company_id,created_at DESC);
CREATE TABLE company.audit(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES placement.companies(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL, action text NOT NULL CHECK(length(action)<=60),
  resource_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_audit_company ON company.audit(company_id,created_at DESC);

-- The signed-in member's company, or NULL. Revoked members and deactivated
-- companies lose access immediately.
CREATE FUNCTION company.actor_company() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT m.company_id FROM company.members m JOIN placement.companies c ON c.id=m.company_id
  WHERE m.user_id=erp.actor_id() AND m.active AND c.active
$$;
CREATE FUNCTION company.assert_member() RETURNS uuid LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE target uuid;
BEGIN
  IF erp.actor_id() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Sign in to continue.'; END IF;
  target:=company.actor_company();
  IF target IS NULL THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Company portal access is required.'; END IF;
  RETURN target;
END $$;
CREATE FUNCTION company.is_member() RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT company.actor_company() IS NOT NULL
$$;

-- ---------------------------------------------------------------- files
-- Metadata for private Supabase Storage objects. Bytes never enter Postgres;
-- the backend signs a short-lived URL only after files.can_read() allows it.
CREATE TABLE files.objects(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL CHECK(bucket IN ('drive-documents','resumes')),
  path text NOT NULL UNIQUE CHECK(length(path) BETWEEN 1 AND 300),
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK(mime='application/pdf'),
  size integer NOT NULL CHECK(size BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  owner_kind text NOT NULL CHECK(owner_kind IN ('company','student')),
  company_id uuid REFERENCES placement.companies(id) ON DELETE CASCADE,
  student_id uuid REFERENCES erp.students(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((owner_kind='company')=(company_id IS NOT NULL)),
  CHECK((owner_kind='student')=(student_id IS NOT NULL))
);
CREATE INDEX files_company ON files.objects(company_id,created_at DESC) WHERE company_id IS NOT NULL;
CREATE INDEX files_student ON files.objects(student_id,created_at DESC) WHERE student_id IS NOT NULL;

-- A student's resume files live beside the extracted text the AI features use.
ALTER TABLE student.documents ADD COLUMN file_id uuid REFERENCES files.objects(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- drives
ALTER TABLE placement.drives
  ADD COLUMN origin text NOT NULL DEFAULT 'officer' CHECK(origin IN ('officer','company')),
  ADD COLUMN ctc_fixed_lpa numeric CHECK(ctc_fixed_lpa IS NULL OR ctc_fixed_lpa BETWEEN 0 AND 10000),
  ADD COLUMN ctc_variable_lpa numeric CHECK(ctc_variable_lpa IS NULL OR ctc_variable_lpa BETWEEN 0 AND 10000),
  ADD COLUMN stipend_monthly numeric CHECK(stipend_monthly IS NULL OR stipend_monthly BETWEEN 0 AND 10000000),
  ADD COLUMN internship_months integer CHECK(internship_months IS NULL OR internship_months BETWEEN 1 AND 36),
  ADD COLUMN bond_months integer CHECK(bond_months IS NULL OR bond_months BETWEEN 0 AND 120),
  ADD COLUMN bond_details text CHECK(length(bond_details)<=2000),
  ADD COLUMN work_mode text CHECK(work_mode IS NULL OR work_mode IN ('onsite','hybrid','remote')),
  ADD COLUMN joining_date date,
  ADD COLUMN jd_file_id uuid REFERENCES files.objects(id) ON DELETE SET NULL,
  ADD COLUMN audience_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN applicants_released_at timestamptz,
  ADD COLUMN applicants_released_by uuid;

-- Who receives a drive. Legacy drives (audience_mode false) keep the original
-- rule: every published drive is visible to its whole batch.
CREATE TABLE placement.drive_audience_rules(
  drive_id uuid PRIMARY KEY REFERENCES placement.drives(id) ON DELETE CASCADE,
  batches text[] NOT NULL CHECK(cardinality(batches) BETWEEN 1 AND 10),
  branches text[] NOT NULL DEFAULT '{}' CHECK(cardinality(branches)<=100),
  min_cgpa numeric CHECK(min_cgpa IS NULL OR min_cgpa BETWEEN 0 AND 10),
  max_backlogs integer CHECK(max_backlogs IS NULL OR max_backlogs BETWEEN 0 AND 100),
  min_attendance numeric CHECK(min_attendance IS NULL OR min_attendance BETWEEN 0 AND 100),
  updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE placement.drive_audience_overrides(
  drive_id uuid REFERENCES placement.drives(id) ON DELETE CASCADE,
  student_id uuid REFERENCES erp.students(id) ON DELETE CASCADE,
  action text NOT NULL CHECK(action IN ('add','remove')),
  recorded_by uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(drive_id,student_id)
);
CREATE TABLE placement.drive_audience(
  drive_id uuid REFERENCES placement.drives(id) ON DELETE CASCADE,
  student_id uuid REFERENCES erp.students(id) ON DELETE CASCADE,
  source text NOT NULL CHECK(source IN ('rules','added')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(drive_id,student_id)
);
CREATE INDEX placement_drive_audience_student ON placement.drive_audience(student_id);

-- What the student agreed to share with the company when applying.
ALTER TABLE placement.registrations
  ADD COLUMN resume_file_id uuid REFERENCES files.objects(id) ON DELETE SET NULL,
  ADD COLUMN consent_at timestamptz,
  ADD COLUMN shared_fields text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------- requests
CREATE TABLE company.drive_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES placement.companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('new','change')),
  drive_id uuid REFERENCES placement.drives(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','returned','approved','rejected')),
  title text CHECK(length(title)<=200),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=12000),
  job_category text CHECK(length(job_category)<=100),
  employment_type text CHECK(employment_type IS NULL OR employment_type IN ('full-time','internship','internship-ppo','contract')),
  openings integer CHECK(openings IS NULL OR openings BETWEEN 1 AND 100000),
  package_lpa numeric CHECK(package_lpa IS NULL OR package_lpa BETWEEN 0 AND 10000),
  ctc_fixed_lpa numeric CHECK(ctc_fixed_lpa IS NULL OR ctc_fixed_lpa BETWEEN 0 AND 10000),
  ctc_variable_lpa numeric CHECK(ctc_variable_lpa IS NULL OR ctc_variable_lpa BETWEEN 0 AND 10000),
  stipend_monthly numeric CHECK(stipend_monthly IS NULL OR stipend_monthly BETWEEN 0 AND 10000000),
  internship_months integer CHECK(internship_months IS NULL OR internship_months BETWEEN 1 AND 36),
  bond_months integer CHECK(bond_months IS NULL OR bond_months BETWEEN 0 AND 120),
  bond_details text CHECK(length(bond_details)<=2000),
  work_mode text CHECK(work_mode IS NULL OR work_mode IN ('onsite','hybrid','remote')),
  joining_date date,
  location text CHECK(length(location)<=200),
  skills text NOT NULL DEFAULT '' CHECK(length(skills)<=2000),
  required_documents text NOT NULL DEFAULT '' CHECK(length(required_documents)<=2000),
  rounds text[] NOT NULL DEFAULT '{}' CHECK(cardinality(rounds)<=20),
  drive_date date, registration_deadline date,
  -- The company's wishes. The officer decides the real audience on approval.
  criteria jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(criteria)='object'),
  jd_file_id uuid REFERENCES files.objects(id) ON DELETE SET NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz, reviewed_by uuid, reviewed_at timestamptz,
  review_comment text CHECK(length(review_comment)<=2000),
  revision integer NOT NULL DEFAULT 1,
  CHECK(kind='new' OR drive_id IS NOT NULL OR status IN ('approved','rejected')),
  CHECK(registration_deadline IS NULL OR drive_date IS NULL OR registration_deadline<=drive_date)
);
CREATE INDEX company_requests_company ON company.drive_requests(company_id,updated_at DESC);
CREATE INDEX company_requests_status ON company.drive_requests(status,submitted_at) WHERE status='submitted';
-- At most one open change request per live drive.
CREATE UNIQUE INDEX company_requests_open_change ON company.drive_requests(drive_id) WHERE kind='change' AND status IN ('draft','submitted','returned');

-- ---------------------------------------------------------------- access rules
ALTER TABLE company.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE company.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE company.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE company.drive_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement.drive_audience_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement.drive_audience_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement.drive_audience ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA company FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA files FROM PUBLIC,anon,authenticated;
REVOKE ALL ON placement.drive_audience_rules,placement.drive_audience_overrides,placement.drive_audience FROM PUBLIC,anon,authenticated;

-- Officers: everything they need to invite, review and target.
GRANT SELECT,INSERT,UPDATE ON company.members,company.invites TO dsu_placement;
GRANT SELECT ON company.audit TO dsu_placement;
GRANT SELECT,UPDATE ON company.drive_requests TO dsu_placement;
GRANT SELECT ON files.objects TO dsu_placement;
GRANT SELECT,INSERT,UPDATE,DELETE ON placement.drive_audience_rules,placement.drive_audience_overrides,placement.drive_audience TO dsu_placement;
CREATE POLICY officer_access ON company.members TO dsu_placement USING(placement.authorized()) WITH CHECK(placement.authorized());
CREATE POLICY officer_access ON company.invites TO dsu_placement USING(placement.authorized()) WITH CHECK(placement.authorized());
CREATE POLICY officer_read ON company.audit FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_access ON company.drive_requests TO dsu_placement USING(placement.authorized() AND status<>'draft') WITH CHECK(placement.authorized());
CREATE POLICY officer_read ON files.objects FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_access ON placement.drive_audience_rules TO dsu_placement USING(placement.authorized()) WITH CHECK(placement.authorized());
CREATE POLICY officer_access ON placement.drive_audience_overrides TO dsu_placement USING(placement.authorized()) WITH CHECK(placement.authorized());
CREATE POLICY officer_access ON placement.drive_audience TO dsu_placement USING(placement.authorized()) WITH CHECK(placement.authorized());

-- Companies: only rows of the signed-in member's own company.
GRANT SELECT ON company.members TO dsu_company;
GRANT SELECT,INSERT,UPDATE,DELETE ON company.drive_requests TO dsu_company;
GRANT SELECT,INSERT ON company.audit TO dsu_company;
GRANT SELECT ON placement.companies,placement.drives TO dsu_company;
GRANT SELECT,UPDATE ON placement.registrations TO dsu_company;
GRANT SELECT,INSERT ON placement.round_results TO dsu_company;
GRANT INSERT ON placement.events TO dsu_company;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA placement TO dsu_company;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA company TO dsu_company;
GRANT SELECT ON erp.students,erp.academics,erp.contacts TO dsu_company;
GRANT SELECT ON files.objects TO dsu_company;
CREATE POLICY own_member ON company.members FOR SELECT TO dsu_company USING(user_id=erp.actor_id());
CREATE POLICY own_company ON company.drive_requests TO dsu_company
  USING(company_id=company.actor_company()) WITH CHECK(company_id=company.actor_company());
CREATE POLICY own_company ON company.audit TO dsu_company
  USING(company_id=company.actor_company()) WITH CHECK(company_id=company.actor_company() AND actor_id=erp.actor_id());
CREATE POLICY own_company ON placement.companies FOR SELECT TO dsu_company USING(id=company.actor_company());
CREATE POLICY own_company ON placement.drives FOR SELECT TO dsu_company USING(company_id=company.actor_company());
-- Applicants become visible only after release, and only with the student's consent.
CREATE FUNCTION company.shared_registration(registration uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM placement.registrations r JOIN placement.drives d ON d.id=r.drive_id
    WHERE r.id=registration AND r.consent_at IS NOT NULL AND d.applicants_released_at IS NOT NULL
      AND d.company_id=company.actor_company())
$$;
CREATE FUNCTION company.shared_student(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM placement.registrations r JOIN placement.drives d ON d.id=r.drive_id
    WHERE r.student_id=target AND r.consent_at IS NOT NULL AND d.applicants_released_at IS NOT NULL
      AND d.company_id=company.actor_company())
$$;
CREATE POLICY shared_applicant ON placement.registrations FOR SELECT TO dsu_company USING(company.shared_registration(id));
CREATE POLICY shared_applicant_update ON placement.registrations FOR UPDATE TO dsu_company
  USING(company.shared_registration(id)) WITH CHECK(company.shared_registration(id));
CREATE POLICY shared_applicant ON placement.round_results FOR SELECT TO dsu_company USING(company.shared_registration(registration_id));
CREATE POLICY shared_applicant_insert ON placement.round_results FOR INSERT TO dsu_company
  WITH CHECK(company.shared_registration(registration_id) AND recorded_by=erp.actor_id());
CREATE POLICY company_audit ON placement.events FOR INSERT TO dsu_company
  WITH CHECK(actor_id=erp.actor_id() AND action LIKE 'company.%');
CREATE POLICY shared_applicant ON erp.students FOR SELECT TO dsu_company USING(company.shared_student(id));
CREATE POLICY shared_applicant ON erp.academics FOR SELECT TO dsu_company USING(company.shared_student(student_id));
CREATE POLICY shared_applicant ON erp.contacts FOR SELECT TO dsu_company USING(company.shared_student(student_id));

-- Students see a published drive only when it is meant for them.
CREATE FUNCTION placement.student_sees_drive(target uuid,viewer uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM placement.drives d WHERE d.id=target AND d.published AND viewer IS NOT NULL AND CASE
    WHEN d.audience_mode THEN EXISTS(SELECT 1 FROM placement.drive_audience a WHERE a.drive_id=d.id AND a.student_id=viewer)
    ELSE d.batch=(SELECT s.source_batch FROM erp.students s WHERE s.id=viewer) END)
$$;
DROP POLICY student_drive_read ON placement.drives;
CREATE POLICY student_drive_read ON placement.drives FOR SELECT TO dsu_api
  USING(erp.actor_role()='student' AND placement.student_sees_drive(id,erp.actor_student()));
GRANT SELECT ON placement.drive_audience TO dsu_api;
CREATE POLICY student_own ON placement.drive_audience FOR SELECT TO dsu_api USING(student_id=erp.actor_student());

-- Files: who may read a file is decided here, in one place.
CREATE FUNCTION files.can_read(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM files.objects f WHERE f.id=target AND (
    student.is_officer()
    OR (f.owner_kind='company' AND f.company_id=company.actor_company())
    OR (f.owner_kind='student' AND f.student_id=erp.actor_student())
    -- A student sees the JD of a drive published to them.
    OR (f.owner_kind='company' AND erp.actor_student() IS NOT NULL AND EXISTS(SELECT 1 FROM placement.drives d
         WHERE d.jd_file_id=f.id AND placement.student_sees_drive(d.id,erp.actor_student())))
    -- A company sees the resume a consenting applicant attached to its released drive.
    OR (f.owner_kind='student' AND company.actor_company() IS NOT NULL AND EXISTS(SELECT 1 FROM placement.registrations r
         JOIN placement.drives d ON d.id=r.drive_id WHERE r.resume_file_id=f.id AND r.consent_at IS NOT NULL
         AND d.applicants_released_at IS NOT NULL AND d.company_id=company.actor_company()))))
$$;
GRANT SELECT,INSERT ON files.objects TO dsu_api;
CREATE POLICY readable ON files.objects FOR SELECT TO dsu_api USING(files.can_read(id));
CREATE POLICY owner_insert ON files.objects FOR INSERT TO dsu_api WITH CHECK(uploaded_by=erp.actor_id() AND (
  (owner_kind='student' AND bucket='resumes' AND student_id=erp.actor_student() AND erp.actor_role()='student')
  OR (owner_kind='company' AND bucket='drive-documents' AND company_id=company.actor_company())));
CREATE POLICY company_files ON files.objects FOR SELECT TO dsu_company USING(files.can_read(id));
-- Direct ownership policies (no lookup), so a row is readable in the statement that inserts it.
CREATE POLICY own_company_files ON files.objects FOR SELECT TO dsu_company USING(owner_kind='company' AND company_id=company.actor_company());
CREATE POLICY own_student_files ON files.objects FOR SELECT TO dsu_api USING(owner_kind='student' AND student_id=erp.actor_student());

-- ---------------------------------------------------------------- audience
-- One definition of "who receives this drive", used by preview, snapshot and tests.
-- spec: {batches[],branches[],min_cgpa,max_backlogs,min_attendance,add[],remove[]}
CREATE FUNCTION placement.audience_spec(spec jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE batches text[]; branches text[]; added uuid[]; removed uuid[]; result jsonb;
BEGIN
  IF spec IS NULL OR jsonb_typeof(spec)<>'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose the drive audience.'; END IF;
  IF jsonb_typeof(coalesce(spec->'batches','[]'))<>'array' OR jsonb_typeof(coalesce(spec->'branches','[]'))<>'array'
    OR jsonb_typeof(coalesce(spec->'add','[]'))<>'array' OR jsonb_typeof(coalesce(spec->'remove','[]'))<>'array' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Audience lists must be arrays.';
  END IF;
  batches:=ARRAY(SELECT DISTINCT v FROM jsonb_array_elements_text(coalesce(spec->'batches','[]')) v ORDER BY 1);
  branches:=ARRAY(SELECT DISTINCT btrim(v) FROM jsonb_array_elements_text(coalesce(spec->'branches','[]')) v WHERE btrim(v)<>'' ORDER BY 1);
  added:=ARRAY(SELECT DISTINCT v::uuid FROM jsonb_array_elements_text(coalesce(spec->'add','[]')) v);
  removed:=ARRAY(SELECT DISTINCT v::uuid FROM jsonb_array_elements_text(coalesce(spec->'remove','[]')) v);
  IF cardinality(batches) NOT BETWEEN 1 AND 10 OR EXISTS(SELECT 1 FROM unnest(batches) b WHERE b !~ '^20[0-9]{2}$') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Choose one to ten graduating batches.';
  END IF;
  IF cardinality(branches)>100 OR EXISTS(SELECT 1 FROM unnest(branches) b WHERE length(b)>100) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Too many branches.';
  END IF;
  IF cardinality(added)>5000 OR cardinality(removed)>5000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Too many individual changes.'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(added) a WHERE a=ANY(removed)) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='A student cannot be both added and removed.';
  END IF;
  result:=jsonb_build_object('batches',to_jsonb(batches),'branches',to_jsonb(branches),
    'min_cgpa',CASE WHEN nullif(spec->>'min_cgpa','') IS NULL THEN NULL ELSE (spec->>'min_cgpa')::numeric END,
    'max_backlogs',CASE WHEN nullif(spec->>'max_backlogs','') IS NULL THEN NULL ELSE (spec->>'max_backlogs')::integer END,
    'min_attendance',CASE WHEN nullif(spec->>'min_attendance','') IS NULL THEN NULL ELSE (spec->>'min_attendance')::numeric END,
    'add',to_jsonb(added),'remove',to_jsonb(removed));
  IF (result->>'min_cgpa')::numeric NOT BETWEEN 0 AND 10 OR (result->>'max_backlogs')::integer NOT BETWEEN 0 AND 100
    OR (result->>'min_attendance')::numeric NOT BETWEEN 0 AND 100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Check the CGPA, backlog and attendance limits.';
  END IF;
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Check the CGPA, backlog and attendance limits and the selected students.';
END $$;

-- Students matching a cleaned spec: rule matches minus removals, plus additions.
-- Students without the academic data a rule needs do not match that rule.
CREATE FUNCTION placement.audience_members(spec jsonb) RETURNS TABLE(student_id uuid,source text) LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT s.id,'rules'::text FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
  WHERE s.source_batch IN (SELECT jsonb_array_elements_text(spec->'batches'))
    AND (jsonb_array_length(spec->'branches')=0 OR s.department_short_name IN (SELECT jsonb_array_elements_text(spec->'branches')))
    AND (spec->>'min_cgpa' IS NULL OR a.cgpa>=(spec->>'min_cgpa')::numeric)
    AND (spec->>'max_backlogs' IS NULL OR a.current_backlog<=(spec->>'max_backlogs')::integer)
    AND (spec->>'min_attendance' IS NULL OR a.attendance>=(spec->>'min_attendance')::numeric)
    AND s.id::text NOT IN (SELECT jsonb_array_elements_text(spec->'remove'))
  UNION
  SELECT s.id,'added' FROM erp.students s WHERE s.id::text IN (SELECT jsonb_array_elements_text(spec->'add'))
$$;

-- Officers preview an audience before approving. spec is cleaned first.
CREATE FUNCTION placement.audience_preview(spec jsonb,query jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE clean jsonb; result jsonb; page_size integer; page_no integer; search text;
BEGIN
  PERFORM placement.assert_officer();
  clean:=placement.audience_spec(spec);
  search:=left(coalesce(query->>'search',''),100);
  page_size:=least(greatest(coalesce(nullif(query->>'limit','')::integer,50),1),200);
  page_no:=greatest(coalesce(nullif(query->>'page','')::integer,1),1);
  WITH members AS MATERIALIZED(
    SELECT m.student_id,m.source,s.enrollment_no usn,s.full_name name,s.department_short_name department,s.source_batch batch,
      a.cgpa,a.current_backlog backlogs,a.attendance,r.dsa,r.github,r.developer
    FROM placement.audience_members(clean) m JOIN erp.students s ON s.id=m.student_id
    LEFT JOIN erp.academics a ON a.student_id=s.id
    LEFT JOIN LATERAL(SELECT x.dsa,x.github,x.developer FROM ranking.scores x JOIN ranking.models md ON md.version=x.model_version AND md.current
      WHERE x.student_id=s.id) r ON true),
  shown AS(SELECT * FROM members WHERE search='' OR strpos(lower(name||' '||usn),lower(search))>0)
  SELECT jsonb_build_object(
    'spec',clean,
    'total',(SELECT count(*) FROM members),
    'added',(SELECT count(*) FROM members WHERE source='added'),
    'removed',jsonb_array_length(clean->'remove'),
    'byDepartment',coalesce((SELECT jsonb_agg(jsonb_build_object('department',coalesce(department,'Unassigned'),'students',n) ORDER BY n DESC,department)
      FROM (SELECT department,count(*) n FROM members GROUP BY department) x),'[]'),
    'byBatch',coalesce((SELECT jsonb_agg(jsonb_build_object('batch',batch,'students',n) ORDER BY batch DESC)
      FROM (SELECT batch,count(*) n FROM members GROUP BY batch) x),'[]'),
    'matching',(SELECT count(*) FROM shown),
    'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',student_id,'usn',usn,'name',name,'department',department,'batch',batch,
        'cgpa',cgpa::text,'backlogs',backlogs,'attendance',attendance::text,'source',source,'dsa',dsa,'github',github,'developer',developer)
        ORDER BY name,usn) FROM (SELECT * FROM shown ORDER BY name,usn LIMIT page_size OFFSET (page_no-1)*page_size) x),'[]'),
    'page',page_no,'limit',page_size) INTO result;
  RETURN result;
END $$;

-- Search students to add by hand (name or USN), with their ranking evidence.
CREATE FUNCTION placement.audience_search(term text,lim integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
  PERFORM placement.assert_officer();
  IF length(btrim(coalesce(term,'')))<2 THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'name'),'[]') INTO result FROM (
    SELECT jsonb_build_object('id',s.id,'usn',s.enrollment_no,'name',s.full_name,'department',s.department_short_name,'batch',s.source_batch,
      'cgpa',a.cgpa::text,'backlogs',a.current_backlog,'dsa',r.dsa,'github',r.github,'developer',r.developer) x
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
    LEFT JOIN LATERAL(SELECT sc.dsa,sc.github,sc.developer FROM ranking.scores sc JOIN ranking.models md ON md.version=sc.model_version AND md.current
      WHERE sc.student_id=s.id) r ON true
    WHERE strpos(lower(s.full_name||' '||s.enrollment_no),lower(btrim(term)))>0
    ORDER BY s.full_name LIMIT least(greatest(lim,1),50)) y;
  RETURN result;
END $$;

-- Replace a drive's audience rules and individual changes, then refresh the
-- snapshot students are matched against. Returns the snapshot size.
CREATE FUNCTION placement.apply_audience(target uuid,spec jsonb,actor uuid) RETURNS integer
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE clean jsonb:=placement.audience_spec(spec); n integer;
BEGIN
  INSERT INTO placement.drive_audience_rules(drive_id,batches,branches,min_cgpa,max_backlogs,min_attendance,updated_by,updated_at)
  VALUES(target,ARRAY(SELECT jsonb_array_elements_text(clean->'batches')),ARRAY(SELECT jsonb_array_elements_text(clean->'branches')),
    (clean->>'min_cgpa')::numeric,(clean->>'max_backlogs')::integer,(clean->>'min_attendance')::numeric,actor,now())
  ON CONFLICT(drive_id) DO UPDATE SET batches=EXCLUDED.batches,branches=EXCLUDED.branches,min_cgpa=EXCLUDED.min_cgpa,
    max_backlogs=EXCLUDED.max_backlogs,min_attendance=EXCLUDED.min_attendance,updated_by=actor,updated_at=now();
  DELETE FROM placement.drive_audience_overrides WHERE drive_id=target;
  INSERT INTO placement.drive_audience_overrides(drive_id,student_id,action,recorded_by)
  SELECT target,v::uuid,'add',actor FROM jsonb_array_elements_text(clean->'add') v
  UNION ALL SELECT target,v::uuid,'remove',actor FROM jsonb_array_elements_text(clean->'remove') v;
  DELETE FROM placement.drive_audience a WHERE a.drive_id=target
    AND NOT EXISTS(SELECT 1 FROM placement.audience_members(clean) m WHERE m.student_id=a.student_id);
  INSERT INTO placement.drive_audience(drive_id,student_id,source)
  SELECT target,m.student_id,m.source FROM placement.audience_members(clean) m
  ON CONFLICT(drive_id,student_id) DO UPDATE SET source=EXCLUDED.source;
  -- Drive columns mirror the rules so every existing screen shows real criteria.
  UPDATE placement.drives SET audience_mode=true,
    batch=CASE WHEN EXISTS(SELECT 1 FROM placement.registrations WHERE drive_id=target) THEN batch ELSE clean->'batches'->>0 END,
    branches=ARRAY(SELECT jsonb_array_elements_text(clean->'branches')),
    min_cgpa=coalesce((clean->>'min_cgpa')::numeric,0),max_backlogs=coalesce((clean->>'max_backlogs')::integer,100),
    min_attendance=(clean->>'min_attendance')::numeric,updated_at=now()
  WHERE id=target;
  SELECT count(*) INTO n FROM placement.drive_audience WHERE drive_id=target;
  RETURN n;
END $$;

-- Audience drives: eligibility is membership plus the upward-only offer rule.
-- The officer's audience replaces the academic filters (hand-picked students
-- may sit outside them). Legacy drives are unchanged.
CREATE OR REPLACE FUNCTION placement.candidates(drive uuid) RETURNS TABLE(
 student_id uuid,usn text,name text,department text,cgpa numeric,backlogs integer,interest text,registration_id uuid,
 eligible boolean,reason text,current_category text,highest_package numeric
) LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT s.id,s.usn,s.name,s.department,s.cgpa,s.backlogs,i.state,r.id,
 CASE WHEN d.audience_mode THEN aud.student_id IS NOT NULL AND coalesce(p.rank,0)<placement.package_rank(d.package_lpa)
 ELSE s.cgpa BETWEEN d.min_cgpa AND 10 AND s.backlogs BETWEEN 0 AND d.max_backlogs
   AND (cardinality(d.branches)=0 OR s.department=ANY(d.branches))
   AND (d.min_attendance IS NULL OR s.attendance>=d.min_attendance)
   AND coalesce(p.rank,0)<placement.package_rank(d.package_lpa) END,
 CASE WHEN d.audience_mode THEN CASE
   WHEN aud.student_id IS NULL THEN 'Not in the drive audience'
   WHEN coalesce(p.rank,0)>=placement.package_rank(d.package_lpa) THEN 'Upward-only placement rule'
   ELSE NULL END
 WHEN s.cgpa IS NULL OR s.backlogs IS NULL THEN 'Academic data missing'
 WHEN NOT (s.cgpa BETWEEN d.min_cgpa AND 10) THEN 'CGPA requirement'
 WHEN s.backlogs>d.max_backlogs THEN 'Backlog requirement'
 WHEN cardinality(d.branches)>0 AND (s.department IS NULL OR NOT s.department=ANY(d.branches)) THEN 'Branch requirement'
 WHEN d.min_attendance IS NOT NULL AND (s.attendance IS NULL OR s.attendance<d.min_attendance) THEN 'Attendance requirement'
 WHEN coalesce(p.rank,0)>=placement.package_rank(d.package_lpa) THEN 'Upward-only placement rule'
 ELSE NULL END,placement.package_category(p.highest),p.highest
 FROM placement.drives d CROSS JOIN LATERAL placement.cohort(CASE WHEN d.audience_mode THEN '{}'::jsonb ELSE jsonb_build_object('batch',d.batch) END) s
 LEFT JOIN placement.drive_audience aud ON aud.drive_id=d.id AND aud.student_id=s.id
 LEFT JOIN placement.interests i ON i.drive_id=d.id AND i.student_id=s.id
 LEFT JOIN placement.registrations r ON r.drive_id=d.id AND r.student_id=s.id
 LEFT JOIN LATERAL(SELECT max(placement.package_rank(o.package_lpa)) AS rank,max(o.package_lpa) AS highest
 FROM placement.offers o JOIN placement.registrations reg ON reg.id=o.registration_id
 WHERE reg.student_id=s.id AND o.status IN ('offered','accepted')) p ON true
 WHERE d.id=drive AND (NOT d.audience_mode OR aud.student_id IS NOT NULL OR r.id IS NOT NULL)
$$;

-- Notices name why the student received the drive.
CREATE OR REPLACE FUNCTION placement.notify_eligible_students(target uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d placement.drives; company_name text; sent integer;
BEGIN
  SELECT * INTO d FROM placement.drives WHERE id=target;
  IF NOT FOUND OR NOT d.published OR d.status NOT IN ('upcoming','ongoing')
    OR (d.registration_deadline IS NOT NULL AND d.registration_deadline < (now() AT TIME ZONE 'Asia/Kolkata')::date) THEN
    RETURN 0;
  END IF;
  SELECT name INTO company_name FROM placement.companies WHERE id=d.company_id;
  WITH eligible AS (
    SELECT c.student_id, m.user_id FROM placement.candidates(target) c
    JOIN erp.memberships m ON m.student_id=c.student_id AND m.role='student'
    WHERE c.eligible IS TRUE AND c.registration_id IS NULL
  ), fresh AS (
    INSERT INTO placement.drive_notices(drive_id, student_id)
    SELECT target, student_id FROM eligible ON CONFLICT DO NOTHING RETURNING student_id
  ), sent_rows AS (
    INSERT INTO student.notifications(user_id, title, body, href)
    SELECT e.user_id,
      left('New drive for you: ' || coalesce(company_name, 'Campus drive') || ', ' || d.title, 200),
      d.package_lpa::text || ' LPA'
        || coalesce(' · Register by ' || to_char(d.registration_deadline, 'DD Mon YYYY'), '')
        || CASE WHEN d.audience_mode THEN ' · The placement office selected you for this drive.'
           ELSE ' · You meet the eligibility criteria.' END,
      '/student/placement?drive=' || target
    FROM eligible e JOIN fresh f ON f.student_id=e.student_id
    RETURNING 1
  )
  SELECT count(*) INTO sent FROM sent_rows;
  RETURN sent;
END $$;
REVOKE ALL ON FUNCTION placement.notify_eligible_students(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- company functions
-- Validates the company's requested criteria (its wishes, not the audience).
CREATE FUNCTION company.clean_criteria(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE batches text[]; branches text[]; result jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value)<>'object' THEN RETURN '{}'::jsonb; END IF;
  IF jsonb_typeof(coalesce(value->'batches','[]'))<>'array' OR jsonb_typeof(coalesce(value->'branches','[]'))<>'array' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Batches and branches must be lists.';
  END IF;
  batches:=ARRAY(SELECT DISTINCT v FROM jsonb_array_elements_text(coalesce(value->'batches','[]')) v ORDER BY 1);
  branches:=ARRAY(SELECT DISTINCT btrim(v) FROM jsonb_array_elements_text(coalesce(value->'branches','[]')) v WHERE btrim(v)<>'' ORDER BY 1);
  IF cardinality(batches)>10 OR EXISTS(SELECT 1 FROM unnest(batches) b WHERE b !~ '^20[0-9]{2}$') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Graduating batches must be years such as 2027.';
  END IF;
  IF cardinality(branches)>50 OR EXISTS(SELECT 1 FROM unnest(branches) b WHERE length(b)>100) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Too many branches.';
  END IF;
  result:=jsonb_strip_nulls(jsonb_build_object('batches',to_jsonb(batches),'branches',to_jsonb(branches),
    'min_cgpa',nullif(value->>'min_cgpa','')::numeric,'max_backlogs',nullif(value->>'max_backlogs','')::integer,
    'min_attendance',nullif(value->>'min_attendance','')::numeric,'notes',nullif(left(btrim(coalesce(value->>'notes','')),2000),'')));
  IF (result->>'min_cgpa')::numeric NOT BETWEEN 0 AND 10 OR (result->>'max_backlogs')::integer NOT BETWEEN 0 AND 100
    OR (result->>'min_attendance')::numeric NOT BETWEEN 0 AND 100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Check the CGPA, backlog and attendance limits.';
  END IF;
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Check the CGPA, backlog and attendance limits.';
END $$;

-- Every request field a company may set, with the live drive for comparison.
CREATE FUNCTION company.request_json(r company.drive_requests) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT to_jsonb(r)-'created_by'-'reviewed_by'||jsonb_build_object(
    'jd_file',(SELECT jsonb_build_object('id',f.id,'filename',f.filename,'size',f.size) FROM files.objects f WHERE f.id=r.jd_file_id),
    'drive',(SELECT jsonb_build_object('id',d.id,'title',d.title,'status',d.status,'published',d.published) FROM placement.drives d WHERE d.id=r.drive_id))
$$;

CREATE FUNCTION company.session() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE target uuid:=company.assert_member(); result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'company',jsonb_build_object('id',c.id,'name',c.name,'shortName',c.short_name,'industry',c.industry,'website',c.website,
      'about',c.about,'headquarters',c.headquarters,'hrName',c.hr_name,'hrEmail',c.hr_email),
    'member',(SELECT jsonb_build_object('email',m.email,'name',m.name,'since',m.created_at) FROM company.members m WHERE m.user_id=erp.actor_id()))
  INTO result FROM placement.companies c WHERE c.id=target;
  RETURN result;
END $$;

CREATE FUNCTION company.requests() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE target uuid:=company.assert_member();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(company.request_json(r) ORDER BY r.updated_at DESC,r.id)
    FROM company.drive_requests r WHERE r.company_id=target),'[]');
END $$;

CREATE FUNCTION company.request(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); r company.drive_requests;
BEGIN
  SELECT * INTO r FROM company.drive_requests WHERE id=target AND company_id=me;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive request not found.'; END IF;
  RETURN company.request_json(r);
END $$;

-- Create (no id) or edit a request. Drafts and returned requests are editable;
-- a change to a live drive starts as a 'change' request copied from the drive.
CREATE FUNCTION company.save_request(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); actor uuid:=erp.actor_id(); target uuid; r company.drive_requests; d placement.drives;
  names text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'object' OR octet_length(p::text)>65536 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid request.'; END IF;
  target:=nullif(p->>'id','')::uuid;
  IF target IS NULL AND nullif(p->>'drive_id','') IS NOT NULL THEN
    -- Request a change to one of this company's live drives.
    SELECT * INTO d FROM placement.drives WHERE id=(p->>'drive_id')::uuid AND company_id=me;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
    IF d.status IN ('completed','cancelled') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='This drive has ended and cannot be changed.'; END IF;
    INSERT INTO company.drive_requests(company_id,kind,drive_id,created_by,title,description,job_category,employment_type,openings,package_lpa,
      ctc_fixed_lpa,ctc_variable_lpa,stipend_monthly,internship_months,bond_months,bond_details,work_mode,joining_date,location,skills,
      required_documents,rounds,drive_date,registration_deadline,jd_file_id,criteria)
    VALUES(me,'change',d.id,actor,d.title,d.description,d.job_category,d.employment_type,d.openings,d.package_lpa,d.ctc_fixed_lpa,d.ctc_variable_lpa,
      d.stipend_monthly,d.internship_months,d.bond_months,d.bond_details,d.work_mode,d.joining_date,d.location,d.skills,d.required_documents,
      d.rounds,d.drive_date,d.registration_deadline,d.jd_file_id,
      coalesce((SELECT r2.criteria FROM company.drive_requests r2 WHERE r2.drive_id=d.id AND r2.status='approved' ORDER BY r2.reviewed_at DESC LIMIT 1),'{}'))
    RETURNING id INTO target;
  ELSIF target IS NULL THEN
    INSERT INTO company.drive_requests(company_id,kind,created_by) VALUES(me,'new',actor) RETURNING id INTO target;
  END IF;
  SELECT * INTO r FROM company.drive_requests WHERE id=target AND company_id=me FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive request not found.'; END IF;
  IF r.status NOT IN ('draft','returned') THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE=CASE r.status WHEN 'submitted' THEN 'This request is with the placement office. Withdraw it to edit.'
      ELSE 'This request is closed. Start a new one to make changes.' END;
  END IF;
  IF p ? 'revision' AND (p->>'revision')::integer IS DISTINCT FROM r.revision THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='This request changed in another window. Reload before saving.';
  END IF;
  IF p ? 'rounds' THEN
    IF jsonb_typeof(p->'rounds')<>'array' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Rounds must be a list.'; END IF;
    names:=ARRAY(SELECT btrim(v) FROM jsonb_array_elements_text(p->'rounds') v WHERE btrim(v)<>'');
    IF cardinality(names)>20 OR EXISTS(SELECT 1 FROM unnest(names) n WHERE length(n)>100)
      OR cardinality(names)<>(SELECT count(DISTINCT n) FROM unnest(names) n) THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE='Provide up to twenty distinct round names.';
    END IF;
  END IF;
  IF nullif(p->>'jd_file_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files.objects f
    WHERE f.id=(p->>'jd_file_id')::uuid AND f.owner_kind='company' AND f.company_id=me) THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='Uploaded file not found.';
  END IF;
  UPDATE company.drive_requests SET
    title=CASE WHEN p ? 'title' THEN nullif(btrim(p->>'title'),'') ELSE title END,
    description=CASE WHEN p ? 'description' THEN coalesce(p->>'description','') ELSE description END,
    job_category=CASE WHEN p ? 'job_category' THEN nullif(btrim(p->>'job_category'),'') ELSE job_category END,
    employment_type=CASE WHEN p ? 'employment_type' THEN nullif(p->>'employment_type','') ELSE employment_type END,
    openings=CASE WHEN p ? 'openings' THEN nullif(p->>'openings','')::integer ELSE openings END,
    package_lpa=CASE WHEN p ? 'package_lpa' THEN nullif(p->>'package_lpa','')::numeric ELSE package_lpa END,
    ctc_fixed_lpa=CASE WHEN p ? 'ctc_fixed_lpa' THEN nullif(p->>'ctc_fixed_lpa','')::numeric ELSE ctc_fixed_lpa END,
    ctc_variable_lpa=CASE WHEN p ? 'ctc_variable_lpa' THEN nullif(p->>'ctc_variable_lpa','')::numeric ELSE ctc_variable_lpa END,
    stipend_monthly=CASE WHEN p ? 'stipend_monthly' THEN nullif(p->>'stipend_monthly','')::numeric ELSE stipend_monthly END,
    internship_months=CASE WHEN p ? 'internship_months' THEN nullif(p->>'internship_months','')::integer ELSE internship_months END,
    bond_months=CASE WHEN p ? 'bond_months' THEN nullif(p->>'bond_months','')::integer ELSE bond_months END,
    bond_details=CASE WHEN p ? 'bond_details' THEN nullif(btrim(p->>'bond_details'),'') ELSE bond_details END,
    work_mode=CASE WHEN p ? 'work_mode' THEN nullif(p->>'work_mode','') ELSE work_mode END,
    joining_date=CASE WHEN p ? 'joining_date' THEN nullif(p->>'joining_date','')::date ELSE joining_date END,
    location=CASE WHEN p ? 'location' THEN nullif(btrim(p->>'location'),'') ELSE location END,
    skills=CASE WHEN p ? 'skills' THEN coalesce(btrim(p->>'skills'),'') ELSE skills END,
    required_documents=CASE WHEN p ? 'required_documents' THEN coalesce(btrim(p->>'required_documents'),'') ELSE required_documents END,
    rounds=CASE WHEN p ? 'rounds' THEN names ELSE rounds END,
    drive_date=CASE WHEN p ? 'drive_date' THEN nullif(p->>'drive_date','')::date ELSE drive_date END,
    registration_deadline=CASE WHEN p ? 'registration_deadline' THEN nullif(p->>'registration_deadline','')::date ELSE registration_deadline END,
    criteria=CASE WHEN p ? 'criteria' THEN company.clean_criteria(p->'criteria') ELSE criteria END,
    jd_file_id=CASE WHEN p ? 'jd_file_id' THEN nullif(p->>'jd_file_id','')::uuid ELSE jd_file_id END,
    revision=revision+1,updated_at=now()
  WHERE id=target RETURNING * INTO r;
  INSERT INTO company.audit(company_id,actor_id,action,resource_id) VALUES(me,actor,'request.save',target);
  RETURN company.request_json(r);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR check_violation OR not_null_violation THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Check the dates, numbers and field lengths.';
WHEN unique_violation THEN
  RAISE SQLSTATE 'PT409' USING MESSAGE='This drive already has an open change request.';
END $$;

-- Sends a request to the placement office. Returns the missing fields when incomplete.
CREATE FUNCTION company.submit_request(target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); r company.drive_requests; missing text[]:='{}';
BEGIN
  SELECT * INTO r FROM company.drive_requests WHERE id=target AND company_id=me FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive request not found.'; END IF;
  IF r.status NOT IN ('draft','returned') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Only a draft or returned request can be submitted.'; END IF;
  IF r.title IS NULL THEN missing:=missing||'role title'::text; END IF;
  IF length(btrim(r.description))<20 AND r.jd_file_id IS NULL THEN missing:=missing||'job description or JD PDF'::text; END IF;
  IF r.employment_type IS NULL THEN missing:=missing||'employment type'::text; END IF;
  IF r.package_lpa IS NULL THEN missing:=missing||'package (LPA)'::text; END IF;
  IF r.employment_type IN ('internship','internship-ppo') AND r.stipend_monthly IS NULL THEN missing:=missing||'stipend'::text; END IF;
  IF r.openings IS NULL THEN missing:=missing||'number of openings'::text; END IF;
  IF cardinality(r.rounds)=0 THEN missing:=missing||'selection rounds'::text; END IF;
  IF r.work_mode IS NULL THEN missing:=missing||'work mode'::text; END IF;
  IF jsonb_array_length(coalesce(r.criteria->'batches','[]'))=0 THEN missing:=missing||'graduating batch'::text; END IF;
  IF r.registration_deadline IS NOT NULL AND r.registration_deadline<(now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    missing:=missing||'a registration deadline that has not passed'::text;
  END IF;
  IF cardinality(missing)>0 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Complete before submitting: '||array_to_string(missing,', ')||'.';
  END IF;
  UPDATE company.drive_requests SET status='submitted',submitted_at=now(),revision=revision+1,updated_at=now()
  WHERE id=target RETURNING * INTO r;
  INSERT INTO company.audit(company_id,actor_id,action,resource_id) VALUES(me,erp.actor_id(),'request.submit',target);
  RETURN company.request_json(r);
END $$;

CREATE FUNCTION company.withdraw_request(target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); r company.drive_requests;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company.drive_requests WHERE id=target AND company_id=me) THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='Drive request not found.';
  END IF;
  UPDATE company.drive_requests SET status='draft',submitted_at=NULL,revision=revision+1,updated_at=now()
  WHERE id=target AND company_id=me AND status='submitted' RETURNING * INTO r;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Only a submitted request can be withdrawn.'; END IF;
  INSERT INTO company.audit(company_id,actor_id,action,resource_id) VALUES(me,erp.actor_id(),'request.withdraw',target);
  RETURN company.request_json(r);
END $$;

CREATE FUNCTION company.delete_request(target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member();
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company.drive_requests WHERE id=target AND company_id=me) THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='Drive request not found.';
  END IF;
  DELETE FROM company.drive_requests WHERE id=target AND company_id=me AND status IN ('draft','returned');
  IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Only a draft or returned request can be deleted.'; END IF;
  INSERT INTO company.audit(company_id,actor_id,action,resource_id) VALUES(me,erp.actor_id(),'request.delete',target);
  RETURN jsonb_build_object('deleted',true);
END $$;

-- The company's live drives. Applicant counts appear only once released.
CREATE FUNCTION company.drives() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(company.drive_json(d) ORDER BY d.drive_date DESC NULLS LAST,d.created_at DESC)
    FROM placement.drives d WHERE d.company_id=me AND d.published),'[]');
END $$;

CREATE FUNCTION company.drive_json(d placement.drives) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT jsonb_build_object('id',d.id,'title',d.title,'description',d.description,'status',d.status,'origin',d.origin,
    'jobCategory',d.job_category,'employmentType',d.employment_type,'openings',d.openings,'packageLpa',d.package_lpa,
    'ctcFixedLpa',d.ctc_fixed_lpa,'ctcVariableLpa',d.ctc_variable_lpa,'stipendMonthly',d.stipend_monthly,
    'internshipMonths',d.internship_months,'bondMonths',d.bond_months,'bondDetails',d.bond_details,'workMode',d.work_mode,
    'joiningDate',d.joining_date,'location',d.location,'skills',d.skills,'requiredDocuments',d.required_documents,
    'rounds',to_jsonb(d.rounds),'driveDate',d.drive_date,'registrationDeadline',d.registration_deadline,
    'released',d.applicants_released_at IS NOT NULL,'releasedAt',d.applicants_released_at,
    'jdFile',(SELECT jsonb_build_object('id',f.id,'filename',f.filename,'size',f.size) FROM files.objects f WHERE f.id=d.jd_file_id),
    'applicants',CASE WHEN d.applicants_released_at IS NULL THEN NULL ELSE
      (SELECT count(*) FROM placement.registrations r WHERE r.drive_id=d.id AND r.consent_at IS NOT NULL) END,
    'selected',CASE WHEN d.applicants_released_at IS NULL THEN NULL ELSE
      (SELECT count(*) FROM placement.registrations r WHERE r.drive_id=d.id AND r.consent_at IS NOT NULL AND r.status IN ('selected','placed')) END,
    'openChange',(SELECT jsonb_build_object('id',r.id,'status',r.status) FROM company.drive_requests r
      WHERE r.drive_id=d.id AND r.kind='change' AND r.status IN ('draft','submitted','returned')))
$$;

CREATE FUNCTION company.drive(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); d placement.drives;
BEGIN
  SELECT * INTO d FROM placement.drives WHERE id=target AND company_id=me AND published;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
  RETURN company.drive_json(d);
END $$;

-- Released, consenting applicants with exactly the fields the student agreed to share.
CREATE FUNCTION company.applicants(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); d placement.drives;
BEGIN
  SELECT * INTO d FROM placement.drives WHERE id=target AND company_id=me AND published;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
  IF d.applicants_released_at IS NULL THEN
    RETURN jsonb_build_object('released',false,'rows','[]'::jsonb,'rounds',to_jsonb(d.rounds));
  END IF;
  RETURN jsonb_build_object('released',true,'releasedAt',d.applicants_released_at,'rounds',to_jsonb(d.rounds),'rows',coalesce((
    SELECT jsonb_agg(jsonb_build_object('registrationId',r.id,'status',r.status,'currentRound',r.current_round,'appliedAt',r.created_at,
      'usn',s.enrollment_no,'name',s.full_name,'branch',s.department_short_name,'department',s.department_name,'batch',s.source_batch,
      'cgpa',a.cgpa::text,'backlogs',a.current_backlog,
      'email',CASE WHEN 'email'=ANY(r.shared_fields) THEN c.details->>'email' END,
      'phone',CASE WHEN 'phone'=ANY(r.shared_fields) THEN c.details->>'phoneStudent1' END,
      'resume',CASE WHEN 'resume'=ANY(r.shared_fields) THEN (SELECT jsonb_build_object('id',f.id,'filename',f.filename) FROM files.objects f WHERE f.id=r.resume_file_id) END,
      'results',coalesce((SELECT jsonb_agg(jsonb_build_object('round',rr.round_number,'name',rr.round_name,'result',rr.result,'remarks',rr.remarks)
        ORDER BY rr.round_number) FROM placement.round_results rr WHERE rr.registration_id=r.id),'[]'))
      ORDER BY s.full_name,s.enrollment_no)
    FROM placement.registrations r JOIN erp.students s ON s.id=r.student_id
    LEFT JOIN erp.academics a ON a.student_id=s.id LEFT JOIN erp.contacts c ON c.student_id=s.id
    WHERE r.drive_id=d.id AND r.consent_at IS NOT NULL),'[]'));
END $$;

-- The company records round outcomes for its released applicants. A pass in
-- the last round selects the candidate; offers stay with the placement office.
CREATE FUNCTION company.record_results(target uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); actor uuid:=erp.actor_id(); d placement.drives; reg placement.registrations;
  ids uuid[]; round_no integer; outcome text; next_status text; changed integer:=0; item uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('placement.write'));
  SELECT * INTO d FROM placement.drives WHERE id=target AND company_id=me AND published; -- serialized by the advisory lock above
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
  IF d.applicants_released_at IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='The placement office has not released applicants yet.'; END IF;
  IF d.status='cancelled' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='This drive is cancelled.'; END IF;
  IF (SELECT count(*) FROM company.audit WHERE company_id=me AND actor_id=actor AND action='results.record' AND created_at>now()-interval '1 minute')>=60 THEN
    RAISE SQLSTATE 'PT429' USING MESSAGE='Too many changes. Please wait a moment.';
  END IF;
  IF jsonb_typeof(p->'registration_ids')<>'array' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Select applicants.'; END IF;
  ids:=ARRAY(SELECT DISTINCT v::uuid FROM jsonb_array_elements_text(p->'registration_ids') v);
  IF cardinality(ids) NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Select between one and 500 applicants.'; END IF;
  round_no:=(p->>'round')::integer; outcome:=p->>'result';
  IF outcome IS NULL OR outcome NOT IN ('pass','fail','absent') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose pass, fail or absent.'; END IF;
  IF round_no IS NULL OR round_no NOT BETWEEN 1 AND cardinality(d.rounds) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose a round of this drive.'; END IF;
  FOREACH item IN ARRAY ids LOOP
    SELECT * INTO reg FROM placement.registrations WHERE id=item AND drive_id=d.id AND consent_at IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='An applicant is not part of this drive.'; END IF;
    IF reg.current_round<>round_no OR reg.status NOT IN ('registered','in-progress') THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='An applicant is not awaiting this round. Refresh the list.';
    END IF;
    INSERT INTO placement.round_results(registration_id,round_number,round_name,result,remarks,recorded_by)
    VALUES(reg.id,round_no,d.rounds[round_no],outcome,left(coalesce(p->>'remarks',''),2000),actor);
    next_status:=CASE WHEN outcome<>'pass' THEN 'rejected' WHEN round_no=cardinality(d.rounds) THEN 'selected' ELSE 'in-progress' END;
    UPDATE placement.registrations SET status=next_status,current_round=CASE WHEN outcome='pass' THEN current_round+1 ELSE current_round END,
      revision=revision+1,updated_at=now() WHERE id=reg.id;
    INSERT INTO placement.events(actor_id,action,resource_id,student_id,drive_id,details)
    VALUES(actor,'company.round.record',reg.id,reg.student_id,d.id,jsonb_build_object('round',round_no,'result',outcome,'by','company'));
    changed:=changed+1;
  END LOOP;
  INSERT INTO company.audit(company_id,actor_id,action,resource_id,details)
  VALUES(me,actor,'results.record',d.id,jsonb_build_object('round',round_no,'result',outcome,'count',changed));
  RETURN jsonb_build_object('count',changed);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Check the selected applicants and round.';
END $$;

-- Registers an uploaded JD PDF (the bytes are already in private storage).
CREATE FUNCTION company.add_file(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=company.assert_member(); f files.objects;
BEGIN
  IF (SELECT count(*) FROM files.objects WHERE company_id=me AND created_at>now()-interval '1 hour')>=60 THEN
    RAISE SQLSTATE 'PT429' USING MESSAGE='Too many uploads. Please try again later.';
  END IF;
  INSERT INTO files.objects(id,bucket,path,filename,mime,size,sha256,owner_kind,company_id,uploaded_by)
  VALUES((p->>'id')::uuid,'drive-documents',p->>'path',p->>'filename','application/pdf',(p->>'size')::integer,p->>'sha256','company',me,erp.actor_id())
  RETURNING * INTO f;
  INSERT INTO company.audit(company_id,actor_id,action,resource_id) VALUES(me,erp.actor_id(),'file.upload',f.id);
  RETURN jsonb_build_object('id',f.id,'filename',f.filename,'size',f.size);
END $$;
-- company.add_file inserts as dsu_company.
GRANT INSERT ON files.objects TO dsu_company;
CREATE POLICY company_insert ON files.objects FOR INSERT TO dsu_company
  WITH CHECK(owner_kind='company' AND bucket='drive-documents' AND company_id=company.actor_company() AND uploaded_by=erp.actor_id());

-- Accept an invite: the signed-in account's email must match the invite.
-- Students and officers can never become company members.
CREATE FUNCTION company.accept_invite(hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=erp.actor_id(); invite company.invites; account_email text; company_name text;
BEGIN
  IF actor IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Sign in to continue.'; END IF;
  SELECT * INTO invite FROM company.invites WHERE token_hash=hash FOR UPDATE;
  IF NOT FOUND OR invite.revoked_at IS NOT NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='This invitation link is not valid. Ask the placement office for a new one.'; END IF;
  IF invite.accepted_at IS NOT NULL THEN
    IF invite.accepted_by=actor THEN
      RETURN jsonb_build_object('company',(SELECT name FROM placement.companies WHERE id=invite.company_id),'alreadyAccepted',true);
    END IF;
    RAISE SQLSTATE 'PT409' USING MESSAGE='This invitation has already been used.';
  END IF;
  IF invite.expires_at<now() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='This invitation has expired. Ask the placement office for a new one.'; END IF;
  IF EXISTS(SELECT 1 FROM erp.memberships WHERE user_id=actor) OR EXISTS(SELECT 1 FROM placement.officers WHERE user_id=actor) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='This account already belongs to a campus user. Use a separate company email.';
  END IF;
  SELECT lower(email) INTO account_email FROM auth.users WHERE id=actor;
  IF account_email IS DISTINCT FROM lower(invite.email) THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE='Sign in with the email address the invitation was sent to.';
  END IF;
  IF EXISTS(SELECT 1 FROM company.members WHERE user_id=actor AND company_id<>invite.company_id) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='This account already belongs to another company.';
  END IF;
  INSERT INTO company.members(user_id,company_id,email,name,invite_id) VALUES(actor,invite.company_id,lower(invite.email),invite.name,invite.id)
  ON CONFLICT(user_id) DO UPDATE SET active=true,revoked_at=NULL,revoked_by=NULL,invite_id=invite.id;
  UPDATE company.invites SET accepted_by=actor,accepted_at=now() WHERE id=invite.id;
  INSERT INTO company.audit(company_id,actor_id,action,resource_id) VALUES(invite.company_id,actor,'invite.accept',invite.id);
  SELECT name INTO company_name FROM placement.companies WHERE id=invite.company_id;
  RETURN jsonb_build_object('company',company_name,'alreadyAccepted',false);
END $$;

-- ---------------------------------------------------------------- officer functions
CREATE FUNCTION placement.company_access(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM placement.assert_officer();
  IF NOT EXISTS(SELECT 1 FROM placement.companies WHERE id=target) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Company not found.'; END IF;
  RETURN jsonb_build_object(
    'members',coalesce((SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'email',m.email,'name',m.name,'active',m.active,
      'since',m.created_at,'revokedAt',m.revoked_at) ORDER BY m.active DESC,m.created_at) FROM company.members m WHERE m.company_id=target),'[]'),
    'invites',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'name',i.name,'createdAt',i.created_at,'expiresAt',i.expires_at,
      'state',CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.expires_at<now() THEN 'expired' ELSE 'pending' END)
      ORDER BY i.created_at DESC) FROM (SELECT * FROM company.invites WHERE company_id=target ORDER BY created_at DESC LIMIT 50) i),'[]'));
END $$;

CREATE FUNCTION placement.company_invite(target uuid,address text,person text,hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=placement.assert_officer(); invite company.invites;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM placement.companies WHERE id=target AND active) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Choose an active company.'; END IF;
  IF (SELECT count(*) FROM company.invites WHERE created_by=actor AND created_at>now()-interval '1 hour')>=30 THEN
    RAISE SQLSTATE 'PT429' USING MESSAGE='Too many invitations. Please wait before sending more.';
  END IF;
  -- A new invite replaces any pending invite for the same address.
  UPDATE company.invites SET revoked_at=now() WHERE company_id=target AND lower(email)=lower(btrim(address)) AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO company.invites(company_id,email,name,token_hash,created_by)
  VALUES(target,lower(btrim(address)),nullif(btrim(person),''),hash,actor) RETURNING * INTO invite;
  INSERT INTO placement.events(actor_id,action,resource_id,details) VALUES(actor,'company.invite',invite.id,jsonb_build_object('company',target,'email',invite.email));
  RETURN jsonb_build_object('id',invite.id,'email',invite.email,'expiresAt',invite.expires_at,
    'company',(SELECT name FROM placement.companies WHERE id=target));
EXCEPTION WHEN check_violation THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Enter a valid email address.';
END $$;

CREATE FUNCTION placement.company_invite_revoke(target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=placement.assert_officer();
BEGIN
  UPDATE company.invites SET revoked_at=now() WHERE id=target AND accepted_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Only a pending invitation can be revoked.'; END IF;
  INSERT INTO placement.events(actor_id,action,resource_id) VALUES(actor,'company.invite.revoke',target);
  RETURN jsonb_build_object('revoked',true);
END $$;

CREATE FUNCTION placement.company_member_revoke(member uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=placement.assert_officer();
BEGIN
  UPDATE company.members SET active=false,revoked_at=now(),revoked_by=actor WHERE user_id=member AND active;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Active company member not found.'; END IF;
  INSERT INTO placement.events(actor_id,action,resource_id) VALUES(actor,'company.member.revoke',member);
  RETURN jsonb_build_object('revoked',true);
END $$;

-- Requests awaiting (or past) review. Drafts are private to the company.
CREATE FUNCTION placement.drive_requests(q jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM placement.assert_officer();
  RETURN jsonb_build_object(
    'counts',jsonb_build_object('submitted',(SELECT count(*) FROM company.drive_requests WHERE status='submitted'),
      'returned',(SELECT count(*) FROM company.drive_requests WHERE status='returned'),
      'approved',(SELECT count(*) FROM company.drive_requests WHERE status='approved'),
      'rejected',(SELECT count(*) FROM company.drive_requests WHERE status='rejected')),
    'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'status',r.status,'title',r.title,'company',c.name,'companyId',c.id,
      'packageLpa',r.package_lpa,'employmentType',r.employment_type,'openings',r.openings,'submittedAt',r.submitted_at,'reviewedAt',r.reviewed_at,
      'driveId',r.drive_id,'batches',r.criteria->'batches') ORDER BY (r.status='submitted') DESC,r.submitted_at DESC NULLS LAST,r.id)
      FROM company.drive_requests r JOIN placement.companies c ON c.id=r.company_id
      WHERE r.status<>'draft' AND (nullif(q->>'status','') IS NULL OR r.status=q->>'status')
        AND (nullif(q->>'search','') IS NULL OR strpos(lower(c.name||' '||coalesce(r.title,'')),lower(q->>'search'))>0)),'[]'));
END $$;

CREATE FUNCTION placement.drive_request(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r company.drive_requests;
BEGIN
  PERFORM placement.assert_officer();
  SELECT * INTO r FROM company.drive_requests WHERE id=target AND status<>'draft';
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive request not found.'; END IF;
  RETURN company.request_json(r)||jsonb_build_object(
    'company',(SELECT jsonb_build_object('id',c.id,'name',c.name,'industry',c.industry,'website',c.website,'about',c.about,'headquarters',c.headquarters)
      FROM placement.companies c WHERE c.id=r.company_id),
    'submittedBy',(SELECT jsonb_build_object('email',m.email,'name',m.name) FROM company.members m WHERE m.user_id=r.created_by),
    'live',(SELECT to_jsonb(d)-'revision' FROM placement.drives d WHERE d.id=r.drive_id),
    'audience',(SELECT to_jsonb(a)-'updated_by' FROM placement.drive_audience_rules a WHERE a.drive_id=r.drive_id),
    'audienceChanges',(SELECT jsonb_build_object('add',coalesce(jsonb_agg(o.student_id) FILTER(WHERE o.action='add'),'[]'),
      'remove',coalesce(jsonb_agg(o.student_id) FILTER(WHERE o.action='remove'),'[]')) FROM placement.drive_audience_overrides o WHERE o.drive_id=r.drive_id),
    'options',jsonb_build_object('batches',ARRAY(SELECT DISTINCT source_batch FROM erp.students ORDER BY 1 DESC),
      'departments',ARRAY(SELECT DISTINCT department_short_name FROM erp.students WHERE department_short_name IS NOT NULL ORDER BY 1)));
END $$;

-- Approve, return or reject. Approving a new request creates the drive with
-- the officer's audience and publishes it to exactly that audience; approving
-- a change applies it to the live drive.
CREATE FUNCTION placement.review_request(target uuid,decision text,p jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=placement.assert_officer(); r company.drive_requests; d placement.drives; live_id uuid; first_batch text;
  comment text:=nullif(btrim(coalesce(p->>'comment','')),''); audience_size integer; notified integer:=0; spec jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('placement.write'));
  SELECT * INTO r FROM company.drive_requests WHERE id=target FOR UPDATE;
  IF NOT FOUND OR r.status='draft' THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive request not found.'; END IF;
  IF r.status<>'submitted' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='This request is not awaiting review.'; END IF;
  IF p ? 'revision' AND (p->>'revision')::integer IS DISTINCT FROM r.revision THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='The company changed this request. Reload before deciding.';
  END IF;
  IF length(comment)>2000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Keep the comment under 2000 characters.'; END IF;
  IF decision IN ('return','reject') THEN
    IF comment IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Tell the company why.'; END IF;
    UPDATE company.drive_requests SET status=CASE decision WHEN 'return' THEN 'returned' ELSE 'rejected' END,review_comment=comment,
      reviewed_by=actor,reviewed_at=now(),revision=revision+1,updated_at=now() WHERE id=target RETURNING * INTO r;
    INSERT INTO placement.events(actor_id,action,resource_id,drive_id,details)
    VALUES(actor,'request.'||decision,target,r.drive_id,jsonb_build_object('company',r.company_id));
    RETURN jsonb_build_object('status',r.status);
  END IF;
  IF decision<>'approve' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose approve, return or reject.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM placement.companies WHERE id=r.company_id AND active) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='This company is inactive. Reactivate it before approving.';
  END IF;
  IF r.title IS NULL OR r.package_lpa IS NULL OR cardinality(r.rounds)=0 THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='The request is incomplete. Return it to the company.';
  END IF;
  IF r.kind='new' THEN
    spec:=placement.audience_spec(coalesce(p->'audience','{}'));
    first_batch:=spec->'batches'->>0;
    IF nullif(p->>'academic_year','') IS NOT NULL AND p->>'academic_year' !~ '^20[0-9]{2}-([0-9]{2}|20[0-9]{2})$' THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE='Academic year must look like 2026-27.';
    END IF;
    INSERT INTO placement.drives(company_id,title,description,package_lpa,academic_year,batch,min_cgpa,max_backlogs,branches,rounds,
      drive_date,registration_deadline,status,published,location,skills,required_documents,job_category,employment_type,openings,
      origin,ctc_fixed_lpa,ctc_variable_lpa,stipend_monthly,internship_months,bond_months,bond_details,work_mode,joining_date,jd_file_id)
    VALUES(r.company_id,r.title,r.description,r.package_lpa,
      coalesce(nullif(p->>'academic_year',''),(first_batch::integer-1)::text||'-'||right(first_batch,2)),first_batch,0,100,'{}',r.rounds,
      coalesce(nullif(p->>'drive_date','')::date,r.drive_date),coalesce(nullif(p->>'registration_deadline','')::date,r.registration_deadline),
      'upcoming',false,r.location,r.skills,r.required_documents,r.job_category,r.employment_type,r.openings,
      'company',r.ctc_fixed_lpa,r.ctc_variable_lpa,r.stipend_monthly,r.internship_months,r.bond_months,r.bond_details,r.work_mode,r.joining_date,r.jd_file_id)
    RETURNING id INTO live_id;
    audience_size:=placement.apply_audience(live_id,spec,actor);
    IF audience_size=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='No student matches this audience. Widen the filters or add students.'; END IF;
    -- Publishing after the snapshot exists notifies exactly that audience.
    UPDATE placement.drives SET published=true WHERE id=live_id;
  ELSE
    SELECT * INTO d FROM placement.drives WHERE id=r.drive_id FOR UPDATE;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='The live drive no longer exists. Reject this change.'; END IF;
    IF d.rounds<>r.rounds AND EXISTS(SELECT 1 FROM placement.registrations WHERE drive_id=d.id) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='Rounds are locked after registration starts. Return the change to the company.';
    END IF;
    live_id:=d.id;
    UPDATE placement.drives SET title=r.title,description=r.description,package_lpa=r.package_lpa,rounds=r.rounds,
      drive_date=r.drive_date,registration_deadline=r.registration_deadline,location=r.location,skills=r.skills,
      required_documents=r.required_documents,job_category=r.job_category,employment_type=r.employment_type,openings=r.openings,
      ctc_fixed_lpa=r.ctc_fixed_lpa,ctc_variable_lpa=r.ctc_variable_lpa,stipend_monthly=r.stipend_monthly,internship_months=r.internship_months,
      bond_months=r.bond_months,bond_details=r.bond_details,work_mode=r.work_mode,joining_date=r.joining_date,jd_file_id=r.jd_file_id,
      revision=revision+1,updated_at=now() WHERE id=d.id;
    SELECT count(*) INTO audience_size FROM placement.drive_audience WHERE drive_id=d.id;
  END IF;
  SELECT count(*) INTO notified FROM placement.drive_notices WHERE drive_notices.drive_id=live_id;
  UPDATE company.drive_requests SET status='approved',drive_id=live_id,review_comment=comment,reviewed_by=actor,reviewed_at=now(),
    revision=revision+1,updated_at=now() WHERE id=target;
  INSERT INTO placement.events(actor_id,action,resource_id,drive_id,details)
  VALUES(actor,'request.approve',target,live_id,jsonb_build_object('company',r.company_id,'kind',r.kind,'audience',audience_size));
  RETURN jsonb_build_object('status','approved','driveId',live_id,'audience',audience_size,'notified',notified);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR check_violation THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Check the audience, dates and academic year.';
END $$;

-- Change who receives a live drive (any drive, including officer-created ones).
CREATE FUNCTION placement.save_audience(target uuid,spec jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=placement.assert_officer(); n integer; before integer; sent integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('placement.write'));
  IF NOT EXISTS(SELECT 1 FROM placement.drives WHERE id=target) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
  SELECT count(*) INTO before FROM placement.drive_notices WHERE drive_id=target;
  n:=placement.apply_audience(target,spec,actor);
  IF n=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='No student matches this audience. Widen the filters or add students.'; END IF;
  -- The drive trigger may already have notified newly reached students; this
  -- call covers an unchanged-criteria save. Count what this save sent.
  PERFORM placement.notify_eligible_students(target);
  SELECT count(*)-before INTO sent FROM placement.drive_notices WHERE drive_id=target;
  INSERT INTO placement.events(actor_id,action,resource_id,drive_id,details) VALUES(actor,'drive.audience',target,target,jsonb_build_object('audience',n,'notified',sent));
  RETURN jsonb_build_object('audience',n,'notified',sent);
END $$;

CREATE FUNCTION placement.drive_audience_state(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE d placement.drives;
BEGIN
  PERFORM placement.assert_officer();
  SELECT * INTO d FROM placement.drives WHERE id=target;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
  RETURN jsonb_build_object('audienceMode',d.audience_mode,'origin',d.origin,
    'released',d.applicants_released_at IS NOT NULL,'releasedAt',d.applicants_released_at,
    'consenting',(SELECT count(*) FROM placement.registrations WHERE drive_id=target AND consent_at IS NOT NULL),
    'size',(SELECT count(*) FROM placement.drive_audience WHERE drive_id=target),
    'rules',(SELECT to_jsonb(a)-'updated_by'-'drive_id' FROM placement.drive_audience_rules a WHERE a.drive_id=target),
    'changes',(SELECT jsonb_build_object('add',coalesce(jsonb_agg(o.student_id) FILTER(WHERE o.action='add'),'[]'),
      'remove',coalesce(jsonb_agg(o.student_id) FILTER(WHERE o.action='remove'),'[]')) FROM placement.drive_audience_overrides o WHERE o.drive_id=target),
    'hasPortal',EXISTS(SELECT 1 FROM company.members m WHERE m.company_id=d.company_id AND m.active),
    'options',jsonb_build_object('batches',ARRAY(SELECT DISTINCT source_batch FROM erp.students ORDER BY 1 DESC),
      'departments',ARRAY(SELECT DISTINCT department_short_name FROM erp.students WHERE department_short_name IS NOT NULL ORDER BY 1)));
END $$;

-- Share (or stop sharing) consenting applicants with the company.
CREATE FUNCTION placement.release_applicants(target uuid,released boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=placement.assert_officer(); d placement.drives;
BEGIN
  UPDATE placement.drives SET applicants_released_at=CASE WHEN released THEN coalesce(applicants_released_at,now()) END,
    applicants_released_by=CASE WHEN released THEN actor END,updated_at=now()
  WHERE id=target RETURNING * INTO d;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
  INSERT INTO placement.events(actor_id,action,resource_id,drive_id) VALUES(actor,CASE WHEN released THEN 'applicants.release' ELSE 'applicants.unrelease' END,target,target);
  RETURN jsonb_build_object('released',d.applicants_released_at IS NOT NULL,'releasedAt',d.applicants_released_at,
    'shared',(SELECT count(*) FROM placement.registrations WHERE drive_id=target AND consent_at IS NOT NULL));
END $$;

-- ---------------------------------------------------------------- students
-- The single eligibility decision for a student and a drive (also used by the
-- opportunities API to explain the result).
CREATE FUNCTION student.drive_eligibility(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=erp.actor_student(); d placement.drives; c record;
BEGIN
  IF me IS NULL OR NOT placement.student_sees_drive(target,me) THEN RETURN NULL; END IF;
  SELECT * INTO d FROM placement.drives WHERE id=target;
  SELECT * INTO c FROM placement.candidates(target) x WHERE x.student_id=me;
  RETURN jsonb_build_object('eligible',coalesce(c.eligible,false) AND d.status IN ('upcoming','ongoing')
      AND (d.registration_deadline IS NULL OR d.registration_deadline>=(now() AT TIME ZONE 'Asia/Kolkata')::date),
    'reason',CASE WHEN c.student_id IS NULL THEN 'Not in the drive audience' ELSE c.reason END,
    'audienceMode',d.audience_mode);
END $$;

-- Apply with consent. Company-submitted drives also need a resume PDF.
CREATE FUNCTION student.apply_to_drive(target uuid,resume uuid,consent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=erp.actor_student(); actor uuid:=erp.actor_id(); d placement.drives; verdict jsonb; reg placement.registrations;
BEGIN
  IF me IS NULL OR erp.actor_role() IS DISTINCT FROM 'student' THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Student access is required.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('placement.write'));
  IF NOT placement.student_sees_drive(target,me) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='This opportunity is not available.'; END IF;
  SELECT * INTO d FROM placement.drives WHERE id=target;
  IF consent IS NOT TRUE THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Confirm what will be shared with the company.'; END IF;
  IF resume IS NULL AND d.origin='company' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Attach your resume to apply.'; END IF;
  IF resume IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files.objects f WHERE f.id=resume AND f.owner_kind='student' AND f.student_id=me) THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='Resume not found. Upload it again.';
  END IF;
  verdict:=student.drive_eligibility(target);
  IF NOT (verdict->>'eligible')::boolean THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE=CASE WHEN d.status NOT IN ('upcoming','ongoing') OR d.registration_deadline<(now() AT TIME ZONE 'Asia/Kolkata')::date
      THEN 'Registration is closed for this drive.' ELSE coalesce(verdict->>'reason','You are not eligible for this drive.') END;
  END IF;
  INSERT INTO placement.interests(drive_id,student_id,state,recorded_by) VALUES(target,me,'interested',actor)
  ON CONFLICT(drive_id,student_id) DO UPDATE SET state='interested',recorded_by=actor,recorded_at=now();
  INSERT INTO placement.registrations(drive_id,student_id,resume_file_id,consent_at,shared_fields)
  VALUES(target,me,resume,now(),CASE WHEN resume IS NULL
    THEN ARRAY['name','usn','branch','batch','cgpa','backlogs','status','email','phone']
    ELSE ARRAY['name','usn','branch','batch','cgpa','backlogs','status','email','phone','resume'] END)
  ON CONFLICT(drive_id,student_id) DO NOTHING RETURNING * INTO reg;
  IF reg.id IS NULL THEN RETURN jsonb_build_object('alreadyApplied',true); END IF;
  INSERT INTO placement.events(actor_id,action,resource_id,student_id,drive_id,details)
  VALUES(actor,'student.apply',reg.id,me,target,jsonb_build_object('resume',resume IS NOT NULL));
  RETURN jsonb_build_object('id',reg.id,'status',reg.status);
END $$;

-- ---------------------------------------------------------------- ownership and grants
GRANT CREATE ON SCHEMA company TO dsu_company;
ALTER FUNCTION company.session() OWNER TO dsu_company;
ALTER FUNCTION company.requests() OWNER TO dsu_company;
ALTER FUNCTION company.request(uuid) OWNER TO dsu_company;
ALTER FUNCTION company.save_request(jsonb) OWNER TO dsu_company;
ALTER FUNCTION company.submit_request(uuid) OWNER TO dsu_company;
ALTER FUNCTION company.withdraw_request(uuid) OWNER TO dsu_company;
ALTER FUNCTION company.delete_request(uuid) OWNER TO dsu_company;
ALTER FUNCTION company.drives() OWNER TO dsu_company;
ALTER FUNCTION company.drive(uuid) OWNER TO dsu_company;
ALTER FUNCTION company.applicants(uuid) OWNER TO dsu_company;
ALTER FUNCTION company.record_results(uuid,jsonb) OWNER TO dsu_company;
ALTER FUNCTION company.add_file(jsonb) OWNER TO dsu_company;
REVOKE CREATE ON SCHEMA company FROM dsu_company;
GRANT CREATE ON SCHEMA placement TO dsu_placement;
ALTER FUNCTION placement.audience_preview(jsonb,jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.audience_search(text,integer) OWNER TO dsu_placement;
ALTER FUNCTION placement.company_access(uuid) OWNER TO dsu_placement;
ALTER FUNCTION placement.company_invite(uuid,text,text,text) OWNER TO dsu_placement;
ALTER FUNCTION placement.company_invite_revoke(uuid) OWNER TO dsu_placement;
ALTER FUNCTION placement.company_member_revoke(uuid) OWNER TO dsu_placement;
ALTER FUNCTION placement.drive_requests(jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.drive_request(uuid) OWNER TO dsu_placement;
ALTER FUNCTION placement.review_request(uuid,text,jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.save_audience(uuid,jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.drive_audience_state(uuid) OWNER TO dsu_placement;
ALTER FUNCTION placement.release_applicants(uuid,boolean) OWNER TO dsu_placement;
REVOKE CREATE ON SCHEMA placement FROM dsu_placement;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA company FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA files FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION placement.student_sees_drive(uuid,uuid),placement.audience_spec(jsonb),placement.audience_members(jsonb),
  placement.audience_preview(jsonb,jsonb),placement.audience_search(text,integer),placement.apply_audience(uuid,jsonb,uuid),
  placement.company_access(uuid),placement.company_invite(uuid,text,text,text),placement.company_invite_revoke(uuid),
  placement.company_member_revoke(uuid),placement.drive_requests(jsonb),placement.drive_request(uuid),
  placement.review_request(uuid,text,jsonb),placement.save_audience(uuid,jsonb),placement.drive_audience_state(uuid),
  placement.release_applicants(uuid,boolean),student.drive_eligibility(uuid),student.apply_to_drive(uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated;
-- Helpers the definer roles call.
GRANT EXECUTE ON FUNCTION company.actor_company(),company.assert_member(),company.is_member(),company.shared_registration(uuid),
  company.shared_student(uuid),company.clean_criteria(jsonb),company.request_json(company.drive_requests),company.drive_json(placement.drives)
  TO dsu_company,dsu_placement,dsu_api;
GRANT EXECUTE ON FUNCTION files.can_read(uuid) TO dsu_api,dsu_company,dsu_placement;
GRANT EXECUTE ON FUNCTION placement.student_sees_drive(uuid,uuid) TO dsu_api,dsu_company,dsu_placement;
GRANT EXECUTE ON FUNCTION placement.audience_spec(jsonb),placement.audience_members(jsonb),placement.apply_audience(uuid,jsonb,uuid) TO dsu_placement;
GRANT EXECUTE ON FUNCTION placement.notify_eligible_students(uuid) TO dsu_placement;
GRANT SELECT ON company.drive_requests TO dsu_placement;
GRANT SELECT ON ranking.scores,ranking.models TO dsu_placement;
-- The API role calls the entry points; each checks the actor itself.
GRANT EXECUTE ON FUNCTION company.session(),company.requests(),company.request(uuid),company.save_request(jsonb),
  company.submit_request(uuid),company.withdraw_request(uuid),company.delete_request(uuid),company.drives(),company.drive(uuid),
  company.applicants(uuid),company.record_results(uuid,jsonb),company.add_file(jsonb),company.accept_invite(text) TO dsu_api;
GRANT EXECUTE ON FUNCTION placement.audience_preview(jsonb,jsonb),placement.audience_search(text,integer),placement.company_access(uuid),
  placement.company_invite(uuid,text,text,text),placement.company_invite_revoke(uuid),placement.company_member_revoke(uuid),
  placement.drive_requests(jsonb),placement.drive_request(uuid),placement.review_request(uuid,text,jsonb),placement.save_audience(uuid,jsonb),
  placement.drive_audience_state(uuid),placement.release_applicants(uuid,boolean),
  student.drive_eligibility(uuid),student.apply_to_drive(uuid,uuid,boolean) TO dsu_api;
NOTIFY pgrst,'reload schema';
