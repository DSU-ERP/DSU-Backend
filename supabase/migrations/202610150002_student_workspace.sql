CREATE SCHEMA student;
REVOKE ALL ON SCHEMA student FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA student TO dsu_api;
GRANT USAGE ON SCHEMA placement TO dsu_api;

CREATE FUNCTION student.is_officer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM placement.officers WHERE user_id=erp.actor_id() AND active)
$$;
REVOKE ALL ON FUNCTION student.is_officer() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.is_officer() TO dsu_api;

CREATE TABLE student.profiles(
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
 onboarded boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE student.documents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 filename text NOT NULL CHECK(length(filename)<=200),kind text NOT NULL CHECK(kind IN ('resume','jd','attachment')),
 content text NOT NULL CHECK(length(content)<=80000),sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_documents_user_date ON student.documents(user_id,created_at DESC);
CREATE TABLE student.reports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('career','readiness-plan')),target text,content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_reports_user_kind_date ON student.reports(user_id,kind,created_at DESC);
CREATE TABLE student.conversations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),context jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_conversations_user_date ON student.conversations(user_id,updated_at DESC,id);
CREATE TABLE student.messages(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES student.conversations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,role text NOT NULL CHECK(role IN ('user','assistant')),
 content text NOT NULL CHECK(length(content)<=30000),card jsonb,sources jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_messages_conversation ON student.messages(conversation_id,id);
CREATE TABLE student.interviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 title text NOT NULL,goal text NOT NULL,jd text NOT NULL DEFAULT '',resume_context text NOT NULL DEFAULT '',
 config jsonb NOT NULL,questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),archived boolean NOT NULL DEFAULT false
);
CREATE INDEX student_interviews_user_date ON student.interviews(user_id,created_at DESC,id);
CREATE TABLE student.interview_sessions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 interview_id uuid NOT NULL REFERENCES student.interviews(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN ('mock','proctored')),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','terminated')),
 started_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,ended_at timestamptz,
 questions jsonb NOT NULL DEFAULT '[]',integrity jsonb NOT NULL DEFAULT '[]',report jsonb,termination_reason text
);
CREATE INDEX student_sessions_user_date ON student.interview_sessions(user_id,started_at DESC,id);
CREATE TABLE student.interview_answers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES student.interview_sessions(id) ON DELETE CASCADE,
 question_index integer NOT NULL CHECK(question_index>=0),answer text NOT NULL CHECK(length(answer)<=12000),
 feedback jsonb NOT NULL,original_answer text,original_feedback jsonb,retried boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id,question_index)
);
CREATE TABLE student.assessments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('ai','practice','assigned')),title text NOT NULL,
 questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array'),config jsonb NOT NULL,
 category text,level integer CHECK(level BETWEEN 1 AND 5),batch text,
 code_hash text UNIQUE,opens_at timestamptz,closes_at timestamptz,published boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_assessments_creator_date ON student.assessments(creator_id,created_at DESC,id);
CREATE TABLE student.attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 assessment_id uuid NOT NULL REFERENCES student.assessments(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','submitted','completed')),
 started_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,submitted_at timestamptz,
 answers jsonb NOT NULL DEFAULT '{}',marked jsonb NOT NULL DEFAULT '[]',integrity jsonb NOT NULL DEFAULT '[]',
 result jsonb,identity jsonb NOT NULL DEFAULT '{}',revision integer NOT NULL DEFAULT 1
);
CREATE INDEX student_attempts_user_date ON student.attempts(user_id,started_at DESC,id);
CREATE UNIQUE INDEX student_attempts_one_active ON student.attempts(user_id,assessment_id) WHERE status='active';
CREATE TABLE student.calendar_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES auth.users(id),batch text,title text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('class','interview','practice','deadline','mentoring','other')),
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,location text,description text,
 CHECK(ends_at>starts_at),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_calendar_user_start ON student.calendar_events(user_id,starts_at);
CREATE INDEX student_calendar_batch_start ON student.calendar_events(batch,starts_at) WHERE user_id IS NULL;
CREATE TABLE student.notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 title text NOT NULL,body text,href text,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_notifications_user_date ON student.notifications(user_id,created_at DESC,id);
CREATE TABLE student.activity(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 kind text NOT NULL,resource_id uuid,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_activity_user_date ON student.activity(user_id,created_at DESC);
CREATE TABLE student.ai_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 kind text NOT NULL,status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE INDEX student_ai_requests_user_date ON student.ai_requests(user_id,created_at DESC);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['profiles','documents','reports','conversations','messages','interviews','interview_sessions','interview_answers','attempts','notifications','activity','ai_requests'] LOOP
  EXECUTE format('ALTER TABLE student.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY student_own ON student.%I TO dsu_api USING(user_id=erp.actor_id()) WITH CHECK(user_id=erp.actor_id())',t);
 END LOOP;
END $$;
ALTER TABLE student.assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY assessment_access ON student.assessments TO dsu_api
 USING(creator_id=erp.actor_id() OR student.is_officer() OR (published AND (batch IS NULL OR batch=(SELECT source_batch FROM erp.students WHERE id=erp.actor_student()))))
 WITH CHECK(creator_id=erp.actor_id());
ALTER TABLE student.calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY calendar_access ON student.calendar_events TO dsu_api
 USING(user_id=erp.actor_id() OR student.is_officer() OR (user_id IS NULL AND (batch IS NULL OR batch=(SELECT source_batch FROM erp.students WHERE id=erp.actor_student()))))
 WITH CHECK((user_id=erp.actor_id() AND created_by=erp.actor_id()) OR student.is_officer());
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA student TO dsu_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA student TO dsu_api;
REVOKE ALL ON ALL TABLES IN SCHEMA student FROM PUBLIC,anon,authenticated;

-- Drives are explicitly published to students; existing internal drafts stay private.
ALTER TABLE placement.drives ADD COLUMN published boolean NOT NULL DEFAULT false;
ALTER TABLE placement.drives ADD COLUMN location text;
ALTER TABLE placement.drives ADD COLUMN skills text NOT NULL DEFAULT '';
ALTER TABLE placement.drives ADD COLUMN required_documents text NOT NULL DEFAULT '';
ALTER TABLE placement.drives ADD COLUMN original_pdf_url text CHECK(original_pdf_url IS NULL OR original_pdf_url ~ '^https://[^[:space:]]+$');
CREATE POLICY student_drive_read ON placement.drives FOR SELECT TO dsu_api USING(erp.actor_role()='student' AND published AND batch=(SELECT source_batch FROM erp.students WHERE id=erp.actor_student()));
CREATE POLICY student_company_read ON placement.companies FOR SELECT TO dsu_api USING(erp.actor_role()='student' AND EXISTS(SELECT 1 FROM placement.drives d WHERE d.company_id=placement.companies.id));
CREATE POLICY student_registration_read ON placement.registrations FOR SELECT TO dsu_api USING(erp.actor_role()='student' AND student_id=erp.actor_student());
CREATE POLICY student_registration_create ON placement.registrations FOR INSERT TO dsu_api WITH CHECK(erp.actor_role()='student' AND student_id=erp.actor_student());
CREATE POLICY student_interest_read ON placement.interests FOR SELECT TO dsu_api USING(erp.actor_role()='student' AND student_id=erp.actor_student());
CREATE POLICY student_interest_create ON placement.interests FOR INSERT TO dsu_api WITH CHECK(erp.actor_role()='student' AND student_id=erp.actor_student());
CREATE POLICY student_interest_update ON placement.interests FOR UPDATE TO dsu_api USING(student_id=erp.actor_student()) WITH CHECK(student_id=erp.actor_student());
CREATE POLICY student_offer_read ON placement.offers FOR SELECT TO dsu_api USING(EXISTS(SELECT 1 FROM placement.registrations r WHERE r.id=registration_id AND r.student_id=erp.actor_student()));
GRANT SELECT ON placement.drives,placement.companies,placement.registrations,placement.interests,placement.offers TO dsu_api;
GRANT INSERT ON placement.registrations,placement.interests TO dsu_api;
GRANT UPDATE ON placement.interests TO dsu_api;
CREATE POLICY student_registration_update ON placement.registrations FOR UPDATE TO dsu_api USING(student_id=erp.actor_student()) WITH CHECK(student_id=erp.actor_student());
GRANT UPDATE(status,revision,updated_at) ON placement.registrations TO dsu_api;
GRANT EXECUTE ON FUNCTION placement.package_rank(numeric),placement.package_category(numeric) TO dsu_api;

DO $migration$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('public.dsu_placement_mutate(text,jsonb,uuid)'::regprocedure);
 definition:=replace(definition,'UPDATE placement.drives SET company_id=company.id,','UPDATE placement.drives SET published=coalesce((p->>''published'')::boolean,false),company_id=company.id,');
 definition:=replace(definition,'SET published=coalesce((p->>''published'')::boolean,false),','SET location=nullif(p->>''location'',''''),skills=coalesce(p->>''skills'',''''),required_documents=coalesce(p->>''required_documents'',''''),original_pdf_url=nullif(p->>''original_pdf_url'',''''),published=coalesce((p->>''published'')::boolean,false),');
 definition:=replace(definition,'INSERT INTO placement.drives(company_id,title,description,package_lpa,','INSERT INTO placement.drives(published,company_id,title,description,package_lpa,');
 definition:=replace(definition,'VALUES(company.id,btrim(p->>''title''),','VALUES(coalesce((p->>''published'')::boolean,false),company.id,btrim(p->>''title''),');
 definition:=replace(definition,'INSERT INTO placement.drives(published,company_id,','INSERT INTO placement.drives(location,skills,required_documents,original_pdf_url,published,company_id,');
 definition:=replace(definition,'VALUES(coalesce((p->>''published'')::boolean,false),company.id,','VALUES(nullif(p->>''location'',''''),coalesce(p->>''skills'',''''),coalesce(p->>''required_documents'',''''),nullif(p->>''original_pdf_url'',''''),coalesce((p->>''published'')::boolean,false),company.id,');
 EXECUTE definition;
END $migration$;
NOTIFY pgrst,'reload schema';

CREATE INDEX student_sessions_interview ON student.interview_sessions(interview_id,started_at DESC);
CREATE POLICY officer_assessment_results ON student.attempts FOR SELECT TO dsu_api USING(student.is_officer());
CREATE TABLE student.broadcasts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),creator_id uuid NOT NULL REFERENCES auth.users(id),batch text,title text NOT NULL,body text NOT NULL,href text,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX student_broadcasts_batch_date ON student.broadcasts(batch,created_at DESC);
ALTER TABLE student.broadcasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY broadcast_read ON student.broadcasts FOR SELECT TO dsu_api USING(student.is_officer() OR erp.actor_role()='student' AND (batch IS NULL OR batch=(SELECT source_batch FROM erp.students WHERE id=erp.actor_student())));
CREATE POLICY broadcast_write ON student.broadcasts FOR INSERT TO dsu_api WITH CHECK(student.is_officer() AND creator_id=erp.actor_id());
CREATE TABLE student.notice_reads(user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,broadcast_id uuid NOT NULL REFERENCES student.broadcasts(id) ON DELETE CASCADE,read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,broadcast_id));
ALTER TABLE student.notice_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY notice_own ON student.notice_reads TO dsu_api USING(user_id=erp.actor_id()) WITH CHECK(user_id=erp.actor_id());
GRANT SELECT,INSERT ON student.broadcasts,student.notice_reads TO dsu_api;
REVOKE ALL ON student.broadcasts,student.notice_reads FROM PUBLIC,anon,authenticated;

CREATE POLICY assessment_attempt_history ON student.assessments FOR SELECT TO dsu_api USING(EXISTS(SELECT 1 FROM student.attempts a WHERE a.assessment_id=student.assessments.id AND a.user_id=(SELECT erp.actor_id())));
CREATE POLICY officer_assessment_update ON student.assessments FOR UPDATE TO dsu_api USING(kind='assigned' AND student.is_officer()) WITH CHECK(kind='assigned' AND student.is_officer());
CREATE INDEX student_attempts_assessment_date ON student.attempts(assessment_id,started_at DESC);
