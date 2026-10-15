-- Move CSV ingestion into the existing Placement Officer workspace.
-- Existing administrator API imports remain supported. No data is removed.
CREATE FUNCTION erp.can_import_students() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT erp.actor_id() IS NOT NULL AND (
    EXISTS(SELECT 1 FROM erp.memberships WHERE user_id=erp.actor_id() AND role='admin')
    OR EXISTS(SELECT 1 FROM placement.officers WHERE user_id=erp.actor_id() AND active)
  )
$$;
REVOKE ALL ON FUNCTION erp.can_import_students() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION erp.can_import_students() TO dsu_api;

-- Only the authenticated import handler sets this transaction-local context.
-- Keep other API routes' existing row visibility and write policy unchanged.
CREATE FUNCTION erp.import_context_allowed() RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT coalesce(current_setting('app.student_import',true)='true',false)
    AND erp.can_import_students()
$$;
REVOKE ALL ON FUNCTION erp.import_context_allowed() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION erp.import_context_allowed() TO dsu_api;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['students','academics','contacts'] LOOP
    EXECUTE format('CREATE POLICY officer_import_read ON erp.%I FOR SELECT TO dsu_api USING(erp.import_context_allowed())',table_name);
    EXECUTE format('CREATE POLICY officer_import_insert ON erp.%I FOR INSERT TO dsu_api WITH CHECK(erp.import_context_allowed())',table_name);
    EXECUTE format('CREATE POLICY officer_import_update ON erp.%I FOR UPDATE TO dsu_api USING(erp.import_context_allowed()) WITH CHECK(erp.import_context_allowed())',table_name);
  END LOOP;
END $$;
CREATE POLICY officer_import_history ON erp.import_runs FOR SELECT TO dsu_api
  USING(erp.import_context_allowed());
CREATE POLICY officer_import_log ON erp.import_runs FOR INSERT TO dsu_api
  WITH CHECK(erp.import_context_allowed() AND actor_id=erp.actor_id());
CREATE POLICY officer_import_audit ON erp.audit_events FOR INSERT TO dsu_api
  WITH CHECK(erp.import_context_allowed() AND actor_id=erp.actor_id() AND action='students.import');

-- History reads go directly to Supabase with the signed-in officer's JWT.
GRANT SELECT ON erp.import_runs TO dsu_placement;
CREATE POLICY placement_import_history ON erp.import_runs FOR SELECT TO dsu_placement
  USING(placement.authorized());
CREATE FUNCTION public.dsu_placement_imports() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE payload jsonb;
BEGIN
  PERFORM placement.assert_officer();
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC,r.id),'[]'::jsonb)
    INTO payload FROM (
      SELECT id,source_batch,summary,created_at FROM erp.import_runs
      ORDER BY created_at DESC,id LIMIT 20
    ) r;
  RETURN jsonb_build_object('data',payload);
END $$;
GRANT CREATE ON SCHEMA public TO dsu_placement;
ALTER FUNCTION public.dsu_placement_imports() OWNER TO dsu_placement;
REVOKE CREATE ON SCHEMA public FROM dsu_placement;
REVOKE ALL ON FUNCTION public.dsu_placement_imports() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dsu_placement_imports() TO authenticated;
NOTIFY pgrst,'reload schema';
