-- Notifications for placement officers and company members (students keep
-- student.notifications and batch broadcasts). Marking a notification as read
-- removes it from the user's list; the row stays, with read_at, for audit.
-- Rows are written only by the SECURITY DEFINER helpers and triggers below.

CREATE TABLE erp.notifications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK(audience IN ('officer','company')),
  kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 60),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  body text CHECK(length(body)<=1000),
  href text CHECK(href IS NULL OR href ~ '^/[^/]'),
  entity_type text CHECK(length(entity_type)<=40),
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX erp_notifications_unread ON erp.notifications(recipient,created_at DESC) WHERE read_at IS NULL;
ALTER TABLE erp.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON erp.notifications FROM PUBLIC,anon,authenticated;
GRANT SELECT ON erp.notifications TO dsu_api;
GRANT UPDATE(read_at) ON erp.notifications TO dsu_api;
CREATE POLICY own_notifications ON erp.notifications FOR SELECT TO dsu_api USING(recipient=erp.actor_id());
CREATE POLICY own_notifications_read ON erp.notifications FOR UPDATE TO dsu_api
  USING(recipient=erp.actor_id()) WITH CHECK(recipient=erp.actor_id());

-- Fan-out helpers. Each recipient gets their own row, so one officer marking a
-- notice as read does not hide it from the others.
CREATE FUNCTION erp.notify_officers(kind text,title text,body text,href text,entity_type text,entity_id uuid) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  WITH sent AS (
    INSERT INTO erp.notifications(recipient,audience,kind,title,body,href,entity_type,entity_id)
    SELECT o.user_id,'officer',kind,left(title,200),left(body,1000),href,entity_type,entity_id
    FROM placement.officers o WHERE o.active RETURNING 1)
  SELECT count(*)::integer FROM sent
$$;
CREATE FUNCTION erp.notify_company(target uuid,kind text,title text,body text,href text,entity_type text,entity_id uuid) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  WITH sent AS (
    INSERT INTO erp.notifications(recipient,audience,kind,title,body,href,entity_type,entity_id)
    SELECT m.user_id,'company',kind,left(title,200),left(body,1000),href,entity_type,entity_id
    FROM company.members m WHERE m.company_id=target AND m.active RETURNING 1)
  SELECT count(*)::integer FROM sent
$$;
CREATE FUNCTION erp.notify_student(target uuid,title text,body text,href text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  WITH sent AS (
    INSERT INTO student.notifications(user_id,title,body,href)
    SELECT m.user_id,left(title,200),left(body,1000),href
    FROM erp.memberships m WHERE m.student_id=target AND m.role='student' RETURNING 1)
  SELECT count(*)::integer FROM sent
$$;
REVOKE ALL ON FUNCTION erp.notify_officers(text,text,text,text,text,uuid),erp.notify_company(uuid,text,text,text,text,text,uuid),
  erp.notify_student(uuid,text,text,text) FROM PUBLIC,anon,authenticated,dsu_api;

-- Company drive requests: submitted -> officers; decided -> the company.
CREATE FUNCTION company.request_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE company_name text; label text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  SELECT name INTO company_name FROM placement.companies WHERE id=NEW.company_id;
  label:=coalesce(NEW.title,'Untitled drive');
  IF NEW.status='submitted' THEN
    PERFORM erp.notify_officers('request.submitted',
      CASE WHEN NEW.kind='change' THEN company_name||' requested changes to '||label ELSE company_name||' submitted a new drive: '||label END,
      CASE WHEN NEW.kind='change' THEN 'Review the changes before they reach students.' ELSE 'Review the drive and choose who receives it.' END,
      '/placement/drive-requests/'||NEW.id,'drive_request',NEW.id);
  ELSIF OLD.status='submitted' AND NEW.status IN ('approved','returned','rejected') THEN
    PERFORM erp.notify_company(NEW.company_id,'request.'||NEW.status,
      CASE NEW.status WHEN 'approved' THEN CASE WHEN NEW.kind='change' THEN 'Changes approved: '||label ELSE 'Drive approved: '||label END
        WHEN 'returned' THEN 'Changes requested: '||label ELSE 'Drive not approved: '||label END,
      CASE NEW.status WHEN 'approved' THEN CASE WHEN NEW.kind='change' THEN 'The live drive now shows your changes.'
          ELSE 'The placement office approved the drive and shared it with the students it selected.' END
        ELSE coalesce(NEW.review_comment,'See the placement office''s comment.') END,
      CASE WHEN NEW.status='approved' AND NEW.drive_id IS NOT NULL THEN '/company/drives/'||NEW.drive_id ELSE '/company/requests/'||NEW.id END,
      'drive_request',NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER request_notice AFTER UPDATE OF status ON company.drive_requests FOR EACH ROW EXECUTE FUNCTION company.request_notice();

-- Applicants released -> the company.
CREATE FUNCTION placement.release_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF OLD.applicants_released_at IS NULL AND NEW.applicants_released_at IS NOT NULL THEN
    PERFORM erp.notify_company(NEW.company_id,'applicants.released','Applicants released: '||NEW.title,
      (SELECT count(*) FROM placement.registrations r WHERE r.drive_id=NEW.id AND r.consent_at IS NOT NULL)::text
        ||' consenting applicant(s) are now visible. You can record round results.',
      '/company/drives/'||NEW.id,'drive',NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER release_notice AFTER UPDATE OF applicants_released_at ON placement.drives FOR EACH ROW EXECUTE FUNCTION placement.release_notice();

-- Selected in the final round -> the student. An offer -> the student.
CREATE FUNCTION placement.selection_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d record;
BEGIN
  SELECT dr.id,dr.title,c.name company INTO d FROM placement.drives dr JOIN placement.companies c ON c.id=dr.company_id WHERE dr.id=NEW.drive_id;
  IF TG_TABLE_NAME='registrations' AND NEW.status='selected' AND OLD.status IS DISTINCT FROM 'selected' THEN
    PERFORM erp.notify_student(NEW.student_id,'You have been selected: '||d.company||', '||d.title,
      'You cleared every round. The placement office will confirm your offer.','/student/placement?drive='||d.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER selection_notice AFTER UPDATE OF status ON placement.registrations FOR EACH ROW EXECUTE FUNCTION placement.selection_notice();
CREATE FUNCTION placement.offer_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d record;
BEGIN
  SELECT r.student_id,dr.id,dr.title,c.name company INTO d FROM placement.registrations r JOIN placement.drives dr ON dr.id=r.drive_id
    JOIN placement.companies c ON c.id=dr.company_id WHERE r.id=NEW.registration_id;
  PERFORM erp.notify_student(d.student_id,'Offer from '||d.company||': '||d.title,
    NEW.package_lpa::text||' LPA. Open your placement record for details.','/student/placement?drive='||d.id);
  RETURN NULL;
END $$;
CREATE TRIGGER offer_notice AFTER INSERT ON placement.offers FOR EACH ROW EXECUTE FUNCTION placement.offer_notice();

-- A company recording round results -> officers (one notice per batch of results).
CREATE FUNCTION company.results_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d record;
BEGIN
  IF NEW.action<>'results.record' THEN RETURN NULL; END IF;
  SELECT dr.id,dr.title,c.name company INTO d FROM placement.drives dr JOIN placement.companies c ON c.id=dr.company_id WHERE dr.id=NEW.resource_id;
  PERFORM erp.notify_officers('results.recorded',d.company||' recorded round '||(NEW.details->>'round')||' results: '||d.title,
    (NEW.details->>'count')||' applicant(s) marked '||(NEW.details->>'result')||'.','/placement/drives/'||d.id,'drive',d.id);
  RETURN NULL;
END $$;
CREATE TRIGGER results_notice AFTER INSERT ON company.audit FOR EACH ROW EXECUTE FUNCTION company.results_notice();

REVOKE ALL ON FUNCTION company.request_notice(),placement.release_notice(),placement.selection_notice(),placement.offer_notice(),
  company.results_notice() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
