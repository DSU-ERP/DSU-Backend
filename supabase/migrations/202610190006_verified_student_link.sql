-- A typed USN identifies a record but does not prove ownership. Preserve the
-- legacy function for callers, while requiring the verified identity match
-- used by the normal registration flow. Never rewrite applied migrations.
CREATE OR REPLACE FUNCTION student.link_by_enrollment(usn text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=erp.actor_id(); context jsonb;
BEGIN
  IF actor IS NULL OR usn IS NULL OR length(btrim(usn)) NOT BETWEEN 1 AND 80 THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('student.registration.'||actor::text));
  context:=student.registration_context();
  IF context->>'state'<>'matched' OR
    lower(btrim(context->'official'->>'enrollment_no')) IS DISTINCT FROM lower(btrim(usn)) THEN
    RETURN false;
  END IF;
  RETURN student.link_registration();
END $$;
REVOKE ALL ON FUNCTION student.link_by_enrollment(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.link_by_enrollment(text) TO dsu_api;
