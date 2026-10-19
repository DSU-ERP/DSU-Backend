-- Student self-registration never trusts a typed email or enrollment number to
-- grant access. Only a confirmed Auth email can match an existing official row.
CREATE INDEX contacts_registration_email ON erp.contacts(lower(btrim(details->>'email')));
CREATE TABLE student.registration_drafts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  details jsonb NOT NULL DEFAULT '{}', academic jsonb NOT NULL DEFAULT '{}',
  step integer NOT NULL DEFAULT 0 CHECK(step BETWEEN 0 AND 4),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','completed')),
  revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE student.registration_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY registration_own ON student.registration_drafts TO dsu_api
  USING(user_id=erp.actor_id()) WITH CHECK(user_id=erp.actor_id());
GRANT SELECT,INSERT,UPDATE ON student.registration_drafts TO dsu_api;

CREATE FUNCTION student.registration_context() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=erp.actor_id(); identity_email text; confirmed timestamptz;
  display_name text; member_role text; record_id uuid; candidates uuid[]; official jsonb;
BEGIN
  SELECT lower(btrim(email)),email_confirmed_at,left(raw_user_meta_data->>'full_name',200)
    INTO identity_email,confirmed,display_name FROM auth.users WHERE id=actor;
  IF identity_email IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Sign in to continue.'; END IF;
  IF EXISTS(SELECT 1 FROM placement.officers WHERE user_id=actor AND active) THEN
    RETURN jsonb_build_object('state','officer');
  END IF;
  SELECT role,student_id INTO member_role,record_id FROM erp.memberships WHERE user_id=actor;
  IF member_role IS NOT NULL AND member_role<>'student' THEN
    RETURN jsonb_build_object('state','restricted');
  END IF;
  IF confirmed IS NULL THEN
    RETURN jsonb_build_object('state','verify_email','email',identity_email,'name',display_name);
  END IF;
  IF record_id IS NULL THEN
    SELECT array_agg(c.student_id) INTO candidates FROM erp.contacts c
      WHERE lower(btrim(c.details->>'email'))=identity_email;
    IF coalesce(cardinality(candidates),0)>1 THEN
      RETURN jsonb_build_object('state','review','email',identity_email,'name',display_name);
    END IF;
    record_id:=candidates[1];
    IF record_id IS NOT NULL AND EXISTS(SELECT 1 FROM erp.memberships WHERE student_id=record_id AND user_id<>actor) THEN
      RETURN jsonb_build_object('state','review','email',identity_email,'name',display_name);
    END IF;
  END IF;
  IF record_id IS NULL THEN
    RETURN jsonb_build_object('state','unmatched','email',identity_email,'name',display_name);
  END IF;
  SELECT jsonb_build_object('id',s.id,'full_name',s.full_name,'enrollment_no',s.enrollment_no,
    'department_name',s.department_name,'course_name',s.course_name,'current_semester',s.current_semester,
    'source_batch',s.source_batch,'cgpa',a.cgpa::text,'sgpa',a.sgpa::text,
    'current_backlog',a.current_backlog,'attendance',a.attendance::text,
    'phone',c.details->>'phoneStudent1','city',c.details->>'presentCity') INTO official
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
    LEFT JOIN erp.contacts c ON c.student_id=s.id WHERE s.id=record_id;
  RETURN jsonb_build_object('state','matched','email',identity_email,'name',display_name,'official',official);
END $$;
REVOKE ALL ON FUNCTION student.registration_context() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.registration_context() TO dsu_api;

CREATE FUNCTION student.link_registration() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=erp.actor_id(); context jsonb; record_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('student.registration.'||actor::text));
  -- A concurrent email change cannot alter the verified identity during linking.
  PERFORM 1 FROM auth.users WHERE id=actor FOR SHARE;
  context:=student.registration_context();
  IF context->>'state'<>'matched' THEN RETURN false; END IF;
  record_id:=(context->'official'->>'id')::uuid;
  PERFORM 1 FROM erp.contacts WHERE student_id=record_id FOR SHARE;
  INSERT INTO erp.memberships(user_id,role,student_id) VALUES(actor,'student',record_id)
    ON CONFLICT(user_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM erp.memberships WHERE user_id=actor AND role='student' AND student_id=record_id) THEN
    RETURN false;
  END IF;
  INSERT INTO erp.audit_events(actor_id,action,resource_id) VALUES(actor,'student.email_verified_link',record_id);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION student.link_registration() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.link_registration() TO dsu_api;
