-- Students no longer wait for manual verification.
-- 1. A verified university email <usn>@dsu.edu.in matches that USN's record
--    automatically (same as a matching contact email).
-- 2. Otherwise a verified student may claim an existing record by USN, once:
--    the record must exist and not already belong to another account.
DO $migration$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef('student.registration_context()'::regprocedure);
  anchor := 'WHERE lower(btrim(c.details->>''email''))=identity_email;';
  IF strpos(definition, anchor) = 0 THEN
    RAISE EXCEPTION 'Expected registration email lookup was not found';
  END IF;
  EXECUTE replace(definition, anchor, anchor || '
    IF coalesce(cardinality(candidates),0)=0 AND identity_email LIKE ''%@dsu.edu.in'' THEN
      SELECT array_agg(s.id) INTO candidates FROM erp.students s
        WHERE lower(btrim(s.enrollment_no))=split_part(identity_email,''@'',1);
    END IF;');
END
$migration$;

CREATE FUNCTION student.link_by_enrollment(usn text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=erp.actor_id(); confirmed timestamptz; member_role text; record_id uuid;
BEGIN
  IF actor IS NULL OR usn IS NULL OR length(btrim(usn)) NOT BETWEEN 1 AND 80 THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('student.registration.'||actor::text));
  SELECT email_confirmed_at INTO confirmed FROM auth.users WHERE id=actor;
  IF confirmed IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM placement.officers WHERE user_id=actor AND active) THEN RETURN false; END IF;
  SELECT role INTO member_role FROM erp.memberships WHERE user_id=actor;
  IF member_role IS NOT NULL THEN RETURN false; END IF;
  SELECT id INTO record_id FROM erp.students WHERE upper(btrim(enrollment_no))=upper(btrim(usn)) LIMIT 1;
  IF record_id IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('student.record.'||record_id::text));
  IF EXISTS(SELECT 1 FROM erp.memberships WHERE student_id=record_id) THEN RETURN false; END IF;
  INSERT INTO erp.memberships(user_id,role,student_id) VALUES(actor,'student',record_id);
  INSERT INTO erp.audit_events(actor_id,action,resource_id) VALUES(actor,'student.enrollment_self_link',record_id);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION student.link_by_enrollment(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.link_by_enrollment(text) TO dsu_api;
