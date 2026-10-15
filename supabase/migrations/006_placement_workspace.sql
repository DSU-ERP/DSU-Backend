-- Placement Officer workspace. No production sample records are inserted.
CREATE SCHEMA placement;
REVOKE ALL ON SCHEMA placement FROM PUBLIC,anon,authenticated;
CREATE ROLE dsu_placement NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
DO $$ BEGIN EXECUTE format('GRANT dsu_placement TO %I',current_user); END $$;
GRANT USAGE ON SCHEMA placement,erp TO dsu_placement;

CREATE TABLE placement.officers (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION placement.actor() RETURNS uuid LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
CREATE FUNCTION placement.authorized() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM placement.officers WHERE user_id=placement.actor() AND active)
$$;
CREATE FUNCTION placement.assert_officer() RETURNS uuid LANGUAGE plpgsql STABLE SET search_path='' AS $$
BEGIN
  IF placement.actor() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Sign in to continue.'; END IF;
  IF NOT placement.authorized() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Placement Officer access is required.'; END IF;
  RETURN placement.actor();
END $$;

CREATE TABLE placement.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
  short_name text CHECK(length(short_name)<=50), industry text CHECK(length(industry)<=100),
  website text CHECK(website IS NULL OR website ~ '^https?://[^[:space:]]+$'),
  hr_name text CHECK(length(hr_name)<=200), hr_email text CHECK(hr_email IS NULL OR hr_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  hr_phone text CHECK(length(hr_phone)<=40), active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX placement_company_name ON placement.companies(lower(btrim(name)));
CREATE FUNCTION placement.package_rank(value numeric) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT CASE WHEN value IS NULL OR value<0 OR value='NaN'::numeric OR value='Infinity'::numeric THEN NULL
    WHEN value<=5 THEN 1 WHEN value<=10 THEN 2 WHEN value<=15 THEN 3 ELSE 4 END
$$;
CREATE FUNCTION placement.package_category(value numeric) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT (ARRAY['regular','dream','super-dream','mega'])[placement.package_rank(value)]
$$;
CREATE TABLE placement.drives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES placement.companies(id) ON DELETE CASCADE,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200), description text NOT NULL DEFAULT '' CHECK(length(description)<=12000),
  package_lpa numeric NOT NULL CHECK(package_lpa BETWEEN 0 AND 10000),
  academic_year text NOT NULL CHECK(academic_year ~ '^20[0-9]{2}-([0-9]{2}|20[0-9]{2})$'),
  batch text NOT NULL CHECK(batch ~ '^20[0-9]{2}$'), min_cgpa numeric NOT NULL DEFAULT 0 CHECK(min_cgpa BETWEEN 0 AND 10),
  max_backlogs integer NOT NULL DEFAULT 0 CHECK(max_backlogs BETWEEN 0 AND 100), branches text[] NOT NULL DEFAULT '{}',
  drive_date date, registration_deadline date,
  rounds text[] NOT NULL CHECK(cardinality(rounds) BETWEEN 1 AND 20 AND array_position(rounds,NULL) IS NULL),
  status text NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','ongoing','completed','cancelled')),
  revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(registration_deadline IS NULL OR drive_date IS NULL OR registration_deadline<=drive_date), CHECK(cardinality(branches)<=100)
);
CREATE INDEX placement_drive_batch ON placement.drives(batch,status,drive_date);
CREATE TABLE placement.interests (
  drive_id uuid REFERENCES placement.drives(id) ON DELETE CASCADE,
  student_id uuid REFERENCES erp.students(id) ON DELETE CASCADE,
  state text NOT NULL CHECK(state IN ('invited','interested','not-interested')),
  recorded_by uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(drive_id,student_id)
);
CREATE TABLE placement.registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), drive_id uuid NOT NULL REFERENCES placement.drives(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','in-progress','selected','rejected','withdrawn','placed')),
  current_round integer NOT NULL DEFAULT 1 CHECK(current_round BETWEEN 1 AND 21),
  interest_override boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(drive_id,student_id)
);
CREATE INDEX placement_registration_student ON placement.registrations(student_id,created_at DESC);
CREATE TABLE placement.round_results (
  registration_id uuid REFERENCES placement.registrations(id) ON DELETE CASCADE,
  round_number integer CHECK(round_number BETWEEN 1 AND 20), round_name text NOT NULL,
  result text NOT NULL CHECK(result IN ('pass','fail','absent')), remarks text NOT NULL DEFAULT '' CHECK(length(remarks)<=2000),
  recorded_by uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(registration_id,round_number)
);
CREATE TABLE placement.offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), registration_id uuid NOT NULL UNIQUE REFERENCES placement.registrations(id) ON DELETE CASCADE,
  package_lpa numeric NOT NULL CHECK(package_lpa BETWEEN 0 AND 10000),
  status text NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','declined','revoked')),
  revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX placement_offer_status ON placement.offers(status,created_at DESC);
CREATE TABLE placement.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL,
  action text NOT NULL, resource_id uuid, student_id uuid REFERENCES erp.students(id) ON DELETE SET NULL,
  drive_id uuid REFERENCES placement.drives(id) ON DELETE SET NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX placement_events_student ON placement.events(student_id,created_at DESC);
CREATE TABLE placement.requests (
  actor_id uuid, request_id uuid, action text NOT NULL, payload jsonb NOT NULL,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,request_id)
);

-- These tables store imported observations only; missing results are not zero scores.
CREATE TABLE placement.test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  assessment_id text NOT NULL, assessment_name text NOT NULL, tier integer NOT NULL CHECK(tier IN (1,2)),
  score numeric NOT NULL CHECK(score BETWEEN 0 AND 100000), max_score numeric NOT NULL CHECK(max_score>0 AND max_score<=100000),
  time_seconds integer CHECK(time_seconds>=0), qualified_tier2 boolean, classification text CHECK(classification IN ('Basic','Medium','Advanced')),
  indicators jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(indicators)='object'), flagged boolean NOT NULL DEFAULT false,
  auto_submitted boolean NOT NULL DEFAULT false, completed_at timestamptz NOT NULL, CHECK(score<=max_score),
  UNIQUE(student_id,assessment_id,tier)
);
CREATE INDEX placement_test_student ON placement.test_results(student_id,completed_at DESC);
CREATE TABLE placement.points (
  student_id uuid PRIMARY KEY REFERENCES erp.students(id) ON DELETE CASCADE,
  academic numeric NOT NULL CHECK(academic BETWEEN 0 AND 1000000), github numeric NOT NULL CHECK(github BETWEEN 0 AND 1000000),
  domain numeric NOT NULL CHECK(domain BETWEEN 0 AND 1000000), breakdown jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(breakdown)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE placement.predictions (
  student_id uuid PRIMARY KEY REFERENCES erp.students(id) ON DELETE CASCADE,
  readiness text NOT NULL CHECK(readiness IN ('job-ready','mid-level','entry-level')),
  risk text NOT NULL CHECK(risk IN ('low','medium','high')), roles text[] NOT NULL DEFAULT '{}', domains text[] NOT NULL DEFAULT '{}',
  skills text[] NOT NULL DEFAULT '{}', languages text[] NOT NULL DEFAULT '{}', strengths text[] NOT NULL DEFAULT '{}',
  risks text[] NOT NULL DEFAULT '{}', recommendations text[] NOT NULL DEFAULT '{}',
  alignment numeric CHECK(alignment BETWEEN 0 AND 100), practical numeric CHECK(practical BETWEEN 0 AND 100),
  theoretical numeric CHECK(theoretical BETWEEN 0 AND 100), course_fit numeric CHECK(course_fit BETWEEN 0 AND 100),
  generated_at timestamptz NOT NULL
);
CREATE TABLE placement.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, title text NOT NULL CHECK(length(title)<=120),
  assistant text NOT NULL CHECK(assistant IN ('observation','friday')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE placement.messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES placement.conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL CHECK(length(content)<=30000), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE placement.proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('email','company','drive')),
  payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','completed','cancelled','failed')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);

-- Direct browser table access is never granted. Public RPCs execute as a limited role.
REVOKE ALL ON ALL TABLES IN SCHEMA placement FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA placement TO dsu_placement;
REVOKE ALL ON placement.officers FROM dsu_placement;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA placement TO dsu_placement;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['companies','drives','interests','registrations','round_results','offers','events','requests','test_results','points','predictions','proposals'] LOOP
    EXECUTE format('ALTER TABLE placement.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY officer_access ON placement.%I TO dsu_placement USING(placement.authorized()) WITH CHECK(placement.authorized())',t);
  END LOOP;
END $$;
ALTER TABLE placement.officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_owner ON placement.conversations TO dsu_placement USING(placement.authorized() AND owner_id=placement.actor()) WITH CHECK(placement.authorized() AND owner_id=placement.actor());
CREATE POLICY message_owner ON placement.messages TO dsu_placement USING(EXISTS(SELECT 1 FROM placement.conversations c WHERE c.id=conversation_id)) WITH CHECK(EXISTS(SELECT 1 FROM placement.conversations c WHERE c.id=conversation_id));
GRANT SELECT ON erp.students,erp.academics,erp.contacts TO dsu_placement;
CREATE POLICY placement_students ON erp.students FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY placement_academics ON erp.academics FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY placement_contacts ON erp.contacts FOR SELECT TO dsu_placement USING(placement.authorized());
GRANT EXECUTE ON FUNCTION erp.cgpa_category(numeric),erp.cgpa_rules(),erp.cgpa_scale(),erp.placement_eligible(numeric),erp.placement_policy() TO dsu_placement;

CREATE FUNCTION placement.cohort(q jsonb) RETURNS TABLE(
 id uuid,usn text,name text,batch text,department text,gender text,quota text,semester text,class_batch text,
 cgpa numeric,sgpa numeric,backlogs integer,attendance numeric,category text,eligible boolean
) LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT s.id,s.enrollment_no,s.full_name,s.source_batch,s.department_short_name,c.details->>'gender',s.admission_quota,
 s.current_semester,s.current_batch,a.cgpa,a.sgpa,a.current_backlog,a.attendance,erp.cgpa_category(a.cgpa),erp.placement_eligible(a.cgpa)
 FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id LEFT JOIN erp.contacts c ON c.student_id=s.id
 WHERE (nullif(q->>'batch','') IS NULL OR s.source_batch=q->>'batch')
 AND (nullif(q->>'department','') IS NULL OR coalesce(s.department_short_name,'__missing__')=q->>'department')
 AND (nullif(q->>'search','') IS NULL OR strpos(lower(s.full_name),lower(q->>'search'))>0 OR strpos(lower(s.enrollment_no),lower(q->>'search'))>0)
 AND (nullif(q->>'minimum','') IS NULL OR (erp.cgpa_category(a.cgpa) IS NOT NULL AND a.cgpa >= (q->>'minimum')::numeric))
 AND (nullif(q->>'quota','') IS NULL OR coalesce(s.admission_quota,'__missing__')=q->>'quota')
 AND (nullif(q->>'category','') IS NULL OR coalesce(erp.cgpa_category(a.cgpa),'unclassified')=q->>'category')
 AND (nullif(q->>'eligibility','') IS NULL OR CASE q->>'eligibility' WHEN 'eligible' THEN erp.placement_eligible(a.cgpa) IS TRUE WHEN 'ineligible' THEN erp.placement_eligible(a.cgpa) IS FALSE ELSE erp.placement_eligible(a.cgpa) IS NULL END)
$$;
CREATE FUNCTION placement.offer_facts(q jsonb) RETURNS TABLE(
 id uuid,student_id uuid,usn text,name text,department text,batch text,company_id uuid,company text,drive_id uuid,title text,
 package_lpa numeric,category text,status text,active boolean,created_at timestamptz,revision integer
) LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT o.id,s.id,s.usn,s.name,s.department,s.batch,c.id,c.name,d.id,d.title,o.package_lpa,
 placement.package_category(o.package_lpa),o.status,o.status IN ('offered','accepted'),o.created_at,o.revision
 FROM placement.offers o JOIN placement.registrations r ON r.id=o.registration_id
 JOIN placement.drives d ON d.id=r.drive_id JOIN placement.companies c ON c.id=d.company_id
 JOIN placement.cohort(q-'category') s ON s.id=r.student_id
 WHERE (nullif(q->>'status','') IS NULL OR o.status=q->>'status')
 AND (nullif(q->>'company','') IS NULL OR c.id::text=q->>'company')
 AND (nullif(q->>'package','') IS NULL OR placement.package_category(o.package_lpa)=q->>'package')
 AND (coalesce(q->>'inactive','true')='true' OR o.status IN ('offered','accepted'))
$$;
CREATE FUNCTION placement.candidates(drive uuid) RETURNS TABLE(
 student_id uuid,usn text,name text,department text,cgpa numeric,backlogs integer,interest text,registration_id uuid,
 eligible boolean,reason text,current_category text,highest_package numeric
) LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT s.id,s.usn,s.name,s.department,s.cgpa,s.backlogs,i.state,r.id,
 s.cgpa BETWEEN d.min_cgpa AND 10 AND s.backlogs BETWEEN 0 AND d.max_backlogs
   AND (cardinality(d.branches)=0 OR s.department=ANY(d.branches))
   AND coalesce(p.rank,0)<placement.package_rank(d.package_lpa),
 CASE WHEN s.cgpa IS NULL OR s.backlogs IS NULL THEN 'Academic data missing'
 WHEN NOT (s.cgpa BETWEEN d.min_cgpa AND 10) THEN 'CGPA requirement'
 WHEN s.backlogs>d.max_backlogs THEN 'Backlog requirement'
 WHEN cardinality(d.branches)>0 AND (s.department IS NULL OR NOT s.department=ANY(d.branches)) THEN 'Branch requirement'
 WHEN coalesce(p.rank,0)>=placement.package_rank(d.package_lpa) THEN 'Upward-only placement rule'
 ELSE NULL END,placement.package_category(p.highest),p.highest
 FROM placement.drives d CROSS JOIN LATERAL placement.cohort(jsonb_build_object('batch',d.batch)) s
 LEFT JOIN placement.interests i ON i.drive_id=d.id AND i.student_id=s.id
 LEFT JOIN placement.registrations r ON r.drive_id=d.id AND r.student_id=s.id
 LEFT JOIN LATERAL(SELECT max(placement.package_rank(o.package_lpa)) AS rank,max(o.package_lpa) AS highest
 FROM placement.offers o JOIN placement.registrations reg ON reg.id=o.registration_id
 WHERE reg.student_id=s.id AND o.status IN ('offered','accepted')) p ON true WHERE d.id=drive
$$;

-- RPC functions follow in subsequent migrations; private helpers have no browser grants.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA placement FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA placement TO dsu_placement;
