-- ONLY the guarded competency testing installer may apply this migration.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM testing.environment_marker WHERE key='environment' AND value='dsu-synthetic-placement-testing-v1') THEN RAISE EXCEPTION 'Testing marker required'; END IF;
END $$;
CREATE SCHEMA competency;
REVOKE ALL ON SCHEMA competency FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA competency TO dsu_api;

CREATE TABLE competency.permissions(user_id uuid REFERENCES auth.users(id), permission text CHECK(permission IN('review','manage_rubrics','approve_shortlist')), PRIMARY KEY(user_id,permission));
CREATE FUNCTION competency.can(p text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT student.is_officer() AND EXISTS(SELECT 1 FROM competency.permissions WHERE user_id=erp.actor_id() AND permission=p)
$$;
CREATE FUNCTION competency.reader() RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$ SELECT student.is_officer() OR erp.actor_student() IS NOT NULL $$;
CREATE FUNCTION competency.marker_valid() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM testing.environment_marker WHERE key='environment' AND value='dsu-synthetic-placement-testing-v1')
$$;
CREATE TABLE competency.catalog(code text PRIMARY KEY CHECK(code ~ '^[A-Z]+-[0-9]{2}$'),family text NOT NULL,name text NOT NULL,description text NOT NULL);
CREATE TABLE competency.rubrics(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL REFERENCES competency.catalog,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,status text NOT NULL CHECK(status IN('draft','approved','simulated')),approved_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(code,version),UNIQUE(id,code),CHECK(status<>'approved' OR approved_by IS NOT NULL));
CREATE TABLE competency.roles(id text PRIMARY KEY,name text NOT NULL UNIQUE,family text NOT NULL);
CREATE TABLE competency.templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),role_id text NOT NULL REFERENCES competency.roles,version integer NOT NULL CHECK(version>0),status text NOT NULL CHECK(status IN('draft','approved','simulated')),assessment_set text NOT NULL,minimum_coverage numeric NOT NULL DEFAULT 70 CHECK(minimum_coverage BETWEEN 0 AND 100),approved_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(role_id,version),CHECK(status<>'approved' OR approved_by IS NOT NULL));
CREATE TABLE competency.requirements(template_id uuid NOT NULL REFERENCES competency.templates,code text NOT NULL REFERENCES competency.catalog,rubric_id uuid NOT NULL,weight numeric NOT NULL CHECK(weight>0 AND weight<=100),PRIMARY KEY(template_id,code),FOREIGN KEY(rubric_id,code) REFERENCES competency.rubrics(id,code));
CREATE TABLE competency.evidence(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES erp.students,code text REFERENCES competency.catalog,source_kind text NOT NULL,source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 500),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),description text NOT NULL CHECK(length(description)<=12000),contribution text NOT NULL CHECK(length(contribution)<=2000),provenance text NOT NULL CHECK(provenance IN('synthetic_fixture','student_submitted','platform_verified','institution_verified','reviewed','rejected','unavailable')),review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN('pending','accepted','rejected','conflicting','unavailable')),is_synthetic boolean NOT NULL DEFAULT false,import_batch text,artifact_id uuid REFERENCES student.documents,content_hash text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(student_id,source_kind,source_ref,content_hash),UNIQUE(id,student_id),CHECK(NOT is_synthetic OR provenance='synthetic_fixture'));
CREATE INDEX evidence_student ON competency.evidence(student_id,created_at DESC);
CREATE INDEX evidence_review ON competency.evidence(review_status);
CREATE TABLE competency.metric_definitions(code text PRIMARY KEY,name text NOT NULL,unit text NOT NULL,description text NOT NULL);
CREATE TABLE competency.observations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),evidence_id uuid NOT NULL,student_id uuid NOT NULL,metric_code text NOT NULL REFERENCES competency.metric_definitions,value numeric,observed_at timestamptz NOT NULL,expires_at timestamptz,FOREIGN KEY(evidence_id,student_id) REFERENCES competency.evidence(id,student_id));
CREATE TABLE competency.assessments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES erp.students,code text NOT NULL REFERENCES competency.catalog,rubric_id uuid NOT NULL,assessment_set text NOT NULL,dimensions jsonb NOT NULL,level numeric NOT NULL CHECK(level BETWEEN 0 AND 4),rationale text NOT NULL,status text NOT NULL CHECK(status IN('reviewed','simulated')),is_synthetic boolean NOT NULL DEFAULT false,reviewed_by uuid REFERENCES auth.users(id),supersedes uuid REFERENCES competency.assessments,expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(rubric_id,code) REFERENCES competency.rubrics(id,code),UNIQUE(id,student_id),CHECK((status='simulated' AND is_synthetic) OR (status='reviewed' AND NOT is_synthetic AND reviewed_by IS NOT NULL)));
CREATE INDEX assessments_student ON competency.assessments(student_id,code,created_at DESC);
CREATE UNIQUE INDEX assessment_supersession ON competency.assessments(supersedes) WHERE supersedes IS NOT NULL;
CREATE TABLE competency.assessment_evidence(assessment_id uuid NOT NULL,evidence_id uuid NOT NULL,student_id uuid NOT NULL,PRIMARY KEY(assessment_id,evidence_id),FOREIGN KEY(assessment_id,student_id) REFERENCES competency.assessments(id,student_id),FOREIGN KEY(evidence_id,student_id) REFERENCES competency.evidence(id,student_id));
CREATE TABLE competency.review_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES erp.students,evidence_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 2000),state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','accepted','rejected')),decision text,reviewed_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,FOREIGN KEY(evidence_id,student_id) REFERENCES competency.evidence(id,student_id));
CREATE TABLE competency.extractions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES erp.students,content jsonb NOT NULL,created_by uuid NOT NULL REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE competency.snapshots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES erp.students,template_id uuid NOT NULL REFERENCES competency.templates,cohort jsonb NOT NULL,result jsonb NOT NULL,is_synthetic boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX snapshots_student ON competency.snapshots(student_id,template_id,created_at DESC);
CREATE TABLE competency.invalidations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES erp.students,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX invalidations_student ON competency.invalidations(student_id,created_at);
CREATE TABLE competency.shortlists(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),snapshot_id uuid NOT NULL UNIQUE REFERENCES competency.snapshots,reason text NOT NULL CHECK(length(reason)>=10),created_by uuid NOT NULL REFERENCES auth.users(id),approved_by uuid REFERENCES auth.users(id),state text NOT NULL DEFAULT 'proposed' CHECK(state IN('proposed','approved','rejected')),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE competency.audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id uuid,action text NOT NULL,resource_id text NOT NULL,changes jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE competency.jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),template_id uuid NOT NULL REFERENCES competency.templates,filters jsonb NOT NULL,created_by uuid NOT NULL REFERENCES auth.users(id),state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','completed','failed')),attempts integer NOT NULL DEFAULT 0,processed integer NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);

-- Immutable versions and historical inputs. Corrections insert superseding records.
CREATE FUNCTION competency.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Historical records are immutable'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['rubrics','templates','requirements','assessments','assessment_evidence','snapshots','invalidations','extractions','audit'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON competency.%I FOR EACH ROW EXECUTE FUNCTION competency.immutable()',t);
 END LOOP;
END $$;
CREATE FUNCTION competency.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 INSERT INTO competency.audit(actor_id,action,resource_id,changes) VALUES(erp.actor_id(),TG_TABLE_NAME||':'||TG_OP,coalesce(to_jsonb(NEW)->>'id',to_jsonb(NEW)->>'template_id',to_jsonb(NEW)->>'user_id'),
 jsonb_build_object('before_state',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'state' ELSE NULL END,'after_state',to_jsonb(NEW)->>'state','before_review',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'review_status' ELSE NULL END,'after_review',to_jsonb(NEW)->>'review_status','level',to_jsonb(NEW)->'level','reason',CASE WHEN TG_TABLE_NAME='review_requests' THEN to_jsonb(NEW)->>'decision' ELSE NULL END));
 RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['evidence','assessments','rubrics','templates','review_requests','shortlists','permissions'] LOOP
  EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE ON competency.%I FOR EACH ROW EXECUTE FUNCTION competency.audit_change()',t);
 END LOOP;
END $$;

-- All catalogs require a linked student or active officer. Infra admin alone is insufficient.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['catalog','roles','rubrics','templates','requirements','metric_definitions'] LOOP
  EXECUTE format('ALTER TABLE competency.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY catalog_read ON competency.%I FOR SELECT TO dsu_api USING(competency.reader())',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['evidence','observations','assessments','assessment_evidence','review_requests','extractions','snapshots','invalidations'] LOOP
  EXECUTE format('ALTER TABLE competency.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scoped_read ON competency.%I FOR SELECT TO dsu_api USING(student_id=erp.actor_student() OR student.is_officer())',t);
 END LOOP;
END $$;
ALTER TABLE competency.permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_permissions ON competency.permissions FOR SELECT TO dsu_api USING(user_id=erp.actor_id());
ALTER TABLE competency.shortlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE competency.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE competency.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortlist_read ON competency.shortlists FOR SELECT TO dsu_api USING(student.is_officer());
CREATE POLICY audit_read ON competency.audit FOR SELECT TO dsu_api USING(competency.can('review'));
CREATE POLICY jobs_access ON competency.jobs TO dsu_api USING(competency.can('review')) WITH CHECK(competency.can('review') AND created_by=erp.actor_id());
CREATE POLICY evidence_submit ON competency.evidence FOR INSERT TO dsu_api WITH CHECK(student_id=erp.actor_student() AND created_by=erp.actor_id() AND provenance='student_submitted' AND review_status='pending' AND NOT is_synthetic AND (artifact_id IS NULL OR EXISTS(SELECT 1 FROM student.documents d WHERE d.id=artifact_id AND d.user_id=erp.actor_id())));
CREATE POLICY evidence_review ON competency.evidence FOR UPDATE TO dsu_api USING(competency.can('review')) WITH CHECK(competency.can('review'));
CREATE POLICY request_submit ON competency.review_requests FOR INSERT TO dsu_api WITH CHECK(student_id=erp.actor_student() AND state='pending' AND reviewed_by IS NULL);
CREATE POLICY request_review ON competency.review_requests FOR UPDATE TO dsu_api USING(competency.can('review')) WITH CHECK(competency.can('review'));
CREATE POLICY assess_review ON competency.assessments FOR INSERT TO dsu_api WITH CHECK(competency.can('review') AND reviewed_by=erp.actor_id() AND status='reviewed' AND NOT is_synthetic);
CREATE POLICY assess_sources ON competency.assessment_evidence FOR INSERT TO dsu_api WITH CHECK(competency.can('review'));
CREATE POLICY rubric_manage ON competency.rubrics FOR INSERT TO dsu_api WITH CHECK(competency.can('manage_rubrics') AND status IN('draft','approved') AND (status='draft' OR approved_by=erp.actor_id()));
CREATE POLICY template_manage ON competency.templates FOR INSERT TO dsu_api WITH CHECK(competency.can('manage_rubrics') AND status IN('draft','approved') AND (status='draft' OR approved_by=erp.actor_id()));
CREATE POLICY requirement_manage ON competency.requirements FOR INSERT TO dsu_api WITH CHECK(competency.can('manage_rubrics'));
CREATE POLICY extract_submit ON competency.extractions FOR INSERT TO dsu_api WITH CHECK(competency.reader() AND created_by=erp.actor_id() AND (student_id=erp.actor_student() OR student.is_officer()));
CREATE POLICY snapshot_compute ON competency.snapshots FOR INSERT TO dsu_api WITH CHECK(competency.can('review'));
CREATE POLICY invalidate ON competency.invalidations FOR INSERT TO dsu_api WITH CHECK(competency.can('review'));
CREATE POLICY shortlist_propose ON competency.shortlists FOR INSERT TO dsu_api WITH CHECK(competency.can('review') AND created_by=erp.actor_id() AND state='proposed' AND approved_by IS NULL);
CREATE POLICY shortlist_approve ON competency.shortlists FOR UPDATE TO dsu_api USING(competency.can('approve_shortlist')) WITH CHECK(competency.can('approve_shortlist') AND approved_by=erp.actor_id());
CREATE POLICY audit_insert ON competency.audit FOR INSERT TO dsu_api WITH CHECK(actor_id=erp.actor_id() AND competency.reader());

REVOKE ALL ON ALL TABLES IN SCHEMA competency FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA competency FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION competency.can(text),competency.reader(),competency.marker_valid() TO dsu_api;
GRANT SELECT ON ALL TABLES IN SCHEMA competency TO dsu_api;
GRANT INSERT ON competency.evidence,competency.assessments,competency.assessment_evidence,competency.rubrics,competency.templates,competency.requirements,competency.review_requests,competency.extractions,competency.snapshots,competency.invalidations,competency.shortlists,competency.audit,competency.jobs TO dsu_api;
GRANT UPDATE(review_status) ON competency.evidence TO dsu_api;
GRANT UPDATE(state,decision,reviewed_by,resolved_at) ON competency.review_requests TO dsu_api;
GRANT UPDATE(state,approved_by) ON competency.shortlists TO dsu_api;
GRANT UPDATE(state,attempts,processed,last_error,finished_at) ON competency.jobs TO dsu_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA competency TO dsu_api;

-- Reuse canonical identity without granting officers blanket erp table access.
CREATE FUNCTION competency.student_headers() RETURNS TABLE(id uuid,enrollment_no text,full_name text,source_batch text,department_short_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT s.id,s.enrollment_no,s.full_name,s.source_batch,s.department_short_name FROM erp.students s WHERE s.id=erp.actor_student() OR student.is_officer()
$$;
REVOKE ALL ON FUNCTION competency.student_headers() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION competency.student_headers() TO dsu_api;

CREATE FUNCTION competency.check_template() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ DECLARE tid uuid; total numeric; st text; BEGIN
 tid:=(CASE WHEN TG_TABLE_NAME='templates' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'template_id' END)::uuid;
 SELECT status INTO st FROM competency.templates WHERE id=tid;
 SELECT sum(weight) INTO total FROM competency.requirements WHERE template_id=tid;
 IF total IS NULL OR total<>100 THEN RAISE EXCEPTION 'Role weights must total exactly 100'; END IF;
 IF st='approved' AND EXISTS(SELECT 1 FROM competency.requirements q JOIN competency.rubrics r ON r.id=q.rubric_id WHERE q.template_id=tid AND r.status<>'approved') THEN RAISE EXCEPTION 'Approved roles require approved rubrics'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER valid_weights AFTER INSERT ON competency.templates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION competency.check_template();
CREATE CONSTRAINT TRIGGER valid_requirements AFTER INSERT ON competency.requirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION competency.check_template();
REVOKE ALL ON FUNCTION competency.check_template() FROM PUBLIC,anon,authenticated;
CREATE FUNCTION competency.pending_job_actors() RETURNS TABLE(actor_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT DISTINCT j.created_by FROM competency.jobs j JOIN placement.officers o ON o.user_id=j.created_by AND o.active JOIN competency.permissions p ON p.user_id=j.created_by AND p.permission='review' WHERE j.state='queued' AND j.attempts<3 LIMIT 5
$$;
REVOKE ALL ON FUNCTION competency.pending_job_actors() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION competency.pending_job_actors() TO dsu_api;
