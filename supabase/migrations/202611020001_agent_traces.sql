-- Agent workflow traces for the Admin portal (docs/agent-workflow-visualization).
--
-- Each F.R.I.D.A.Y. request records one run and its steps: node names, timings,
-- status, tool names and redacted metadata. Never prompts, answers, tool
-- arguments, tool results or student records. Rows expire after 7 days.
-- Only accounts on the dedicated ops.admins list can read traces; that list
-- grants nothing else.

CREATE SCHEMA ops;
REVOKE ALL ON SCHEMA ops FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA ops TO dsu_api;

CREATE TABLE ops.admins(
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE FUNCTION ops.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM ops.admins WHERE user_id=erp.actor_id() AND active)
$$;
CREATE FUNCTION ops.assert_admin() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF erp.actor_id() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Sign in to continue.'; END IF;
  IF NOT ops.is_admin() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Admin access is required.'; END IF;
  RETURN erp.actor_id();
END $$;

CREATE TABLE ops.agent_runs(
  id uuid PRIMARY KEY,
  assistant text NOT NULL CHECK(assistant IN ('student','officer','company')),
  workflow_version text NOT NULL CHECK(length(workflow_version) BETWEEN 1 AND 40),
  -- Ownership check for appending steps; never returned to the Admin portal.
  actor_id uuid NOT NULL,
  -- The caller's real role, worked out by the database. 'none' marks an
  -- attempt by an account without that assistant's role (shown as denied).
  actor_role text NOT NULL CHECK(actor_role IN ('student','officer','company','none')),
  company_id uuid REFERENCES placement.companies(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','denied')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_ms integer CHECK(duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  error_category text CHECK(length(error_category)<=40),
  summary jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<=4096),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_agent_runs_started ON ops.agent_runs(started_at DESC);
CREATE INDEX ops_agent_runs_updated ON ops.agent_runs(updated_at DESC);
CREATE INDEX ops_agent_runs_expires ON ops.agent_runs(expires_at);
CREATE TABLE ops.agent_steps(
  run_id uuid NOT NULL REFERENCES ops.agent_runs(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK(seq BETWEEN 1 AND 500),
  parent_seq integer CHECK(parent_seq IS NULL OR parent_seq BETWEEN 1 AND 500),
  node text NOT NULL CHECK(node ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  kind text NOT NULL CHECK(kind IN ('input','auth','guard','limit','context','route','retrieval','tool','model','validate','persist','output')),
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  status text NOT NULL CHECK(status IN ('running','completed','failed','skipped','denied')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_ms integer CHECK(duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 20),
  error_category text CHECK(length(error_category)<=40),
  meta jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(meta)='object' AND octet_length(meta::text)<=2048),
  PRIMARY KEY(run_id,seq)
);
ALTER TABLE ops.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.agent_steps ENABLE ROW LEVEL SECURITY;
-- No direct table access for the API role: everything goes through the functions below.
REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM PUBLIC,anon,authenticated,dsu_api;

-- Validates one batch of steps. Unknown or oversized fields are rejected rather
-- than stored, so a caller cannot smuggle prompts or records into a trace.
CREATE FUNCTION ops.clean_steps(steps jsonb) RETURNS SETOF ops.agent_steps LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE s jsonb; row ops.agent_steps;
BEGIN
  IF steps IS NULL OR jsonb_typeof(steps)<>'array' OR jsonb_array_length(steps)>100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid trace steps.';
  END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(steps) LOOP
    IF jsonb_typeof(s)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k
      WHERE k NOT IN ('seq','parent_seq','node','kind','label','status','started_at','ended_at','duration_ms','attempt','error_category','meta')) THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid trace step.';
    END IF;
    row.seq:=(s->>'seq')::integer; row.parent_seq:=(s->>'parent_seq')::integer; row.node:=s->>'node'; row.kind:=s->>'kind';
    row.label:=s->>'label'; row.status:=s->>'status'; row.started_at:=(s->>'started_at')::timestamptz; row.ended_at:=(s->>'ended_at')::timestamptz;
    row.duration_ms:=(s->>'duration_ms')::integer; row.attempt:=coalesce((s->>'attempt')::integer,1); row.error_category:=s->>'error_category';
    row.meta:=coalesce(s->'meta','{}'::jsonb);
    RETURN NEXT row;
  END LOOP;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid trace step values.';
END $$;

-- Starts a run for the signed-in actor. The role and company are worked out
-- here, never taken from the caller. Also removes expired traces.
CREATE FUNCTION ops.trace_start(p jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=erp.actor_id(); role text; tenant uuid:=company.actor_company();
BEGIN
  IF actor IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Sign in to continue.'; END IF;
  IF p IS NULL OR jsonb_typeof(p)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k
    WHERE k NOT IN ('id','assistant','workflow_version','started_at','summary')) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid trace.';
  END IF;
  role:=CASE WHEN student.is_officer() THEN 'officer' WHEN erp.actor_role()='student' THEN 'student'
    WHEN tenant IS NOT NULL THEN 'company' ELSE 'none' END;
  DELETE FROM ops.agent_runs WHERE id IN (SELECT id FROM ops.agent_runs WHERE expires_at<now() ORDER BY expires_at LIMIT 500);
  IF (SELECT count(*) FROM ops.agent_runs WHERE actor_id=actor AND started_at>now()-interval '1 minute')>=60 THEN RETURN; END IF;
  INSERT INTO ops.agent_runs(id,assistant,workflow_version,actor_id,actor_role,company_id,started_at,summary)
  VALUES((p->>'id')::uuid,p->>'assistant',p->>'workflow_version',actor,role,CASE WHEN role='company' THEN tenant END,
    least(coalesce((p->>'started_at')::timestamptz,now()),now()),coalesce(p->'summary','{}'))
  ON CONFLICT(id) DO NOTHING;
EXCEPTION WHEN invalid_text_representation OR check_violation OR datetime_field_overflow OR invalid_datetime_format OR not_null_violation THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid trace.';
END $$;

-- Adds or updates steps of the actor's own run, and optionally finishes it.
CREATE FUNCTION ops.trace_steps(target uuid,steps jsonb,finish jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=erp.actor_id(); run ops.agent_runs;
BEGIN
  SELECT * INTO run FROM ops.agent_runs WHERE id=target FOR UPDATE;
  -- Missing (rate-limited or expired) runs are ignored; tracing never fails a request.
  IF NOT FOUND THEN RETURN; END IF;
  IF run.actor_id IS DISTINCT FROM actor THEN RAISE SQLSTATE 'PT403' USING MESSAGE='This trace belongs to another account.'; END IF;
  IF run.status<>'running' THEN RETURN; END IF;
  INSERT INTO ops.agent_steps(run_id,seq,parent_seq,node,kind,label,status,started_at,ended_at,duration_ms,attempt,error_category,meta)
  SELECT target,c.seq,c.parent_seq,c.node,c.kind,c.label,c.status,c.started_at,c.ended_at,c.duration_ms,c.attempt,c.error_category,c.meta
  FROM ops.clean_steps(steps) c
  ON CONFLICT(run_id,seq) DO UPDATE SET status=EXCLUDED.status,ended_at=EXCLUDED.ended_at,duration_ms=EXCLUDED.duration_ms,
    attempt=EXCLUDED.attempt,error_category=EXCLUDED.error_category,meta=EXCLUDED.meta,label=EXCLUDED.label;
  IF finish IS NOT NULL THEN
    IF jsonb_typeof(finish)<>'object' OR finish->>'status' NOT IN ('completed','failed','denied') THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid trace result.';
    END IF;
    UPDATE ops.agent_runs SET status=finish->>'status',ended_at=now(),
      duration_ms=least(greatest((extract(epoch FROM now()-started_at)*1000)::integer,0),86400000),
      error_category=left(finish->>'error_category',40),
      summary=CASE WHEN jsonb_typeof(finish->'summary')='object' AND octet_length((finish->'summary')::text)<=4096 THEN summary||(finish->'summary') ELSE summary END,
      updated_at=now()
    WHERE id=target;
  ELSE
    UPDATE ops.agent_runs SET updated_at=now() WHERE id=target;
  END IF;
EXCEPTION WHEN check_violation OR not_null_violation THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid trace step values.';
END $$;

-- Admin reads. Runs never expose the actor id; company runs show the company name.
CREATE FUNCTION ops.run_json(r ops.agent_runs) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT jsonb_build_object('id',r.id,'assistant',r.assistant,'workflowVersion',r.workflow_version,'role',r.actor_role,
    'company',(SELECT c.name FROM placement.companies c WHERE c.id=r.company_id),'status',r.status,'startedAt',r.started_at,
    'endedAt',r.ended_at,'durationMs',r.duration_ms,'errorCategory',r.error_category,'summary',r.summary,'updatedAt',r.updated_at,
    'steps',(SELECT count(*) FROM ops.agent_steps s WHERE s.run_id=r.id),
    'tools',(SELECT count(*) FROM ops.agent_steps s WHERE s.run_id=r.id AND s.kind='tool'),
    'errors',(SELECT count(*) FROM ops.agent_steps s WHERE s.run_id=r.id AND s.status IN ('failed','denied')),
    'toolNames',coalesce((SELECT jsonb_agg(DISTINCT s.meta->>'tool') FROM ops.agent_steps s WHERE s.run_id=r.id AND s.kind='tool' AND s.meta ? 'tool'),'[]'))
$$;
CREATE FUNCTION ops.agent_runs_list(q jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE size integer; since timestamptz; until timestamptz;
BEGIN
  PERFORM ops.assert_admin();
  size:=least(greatest(coalesce(nullif(q->>'limit','')::integer,50),1),200);
  since:=nullif(q->>'since','')::timestamptz; until:=nullif(q->>'until','')::timestamptz;
  RETURN jsonb_build_object(
    'rows',coalesce((SELECT jsonb_agg(ops.run_json(r) ORDER BY r.started_at DESC) FROM (
      SELECT * FROM ops.agent_runs r WHERE r.expires_at>now()
        AND (nullif(q->>'assistant','') IS NULL OR r.assistant=q->>'assistant')
        AND (nullif(q->>'status','') IS NULL OR r.status=q->>'status')
        AND (since IS NULL OR r.started_at>=since) AND (until IS NULL OR r.started_at<until)
        AND (nullif(q->>'tool','') IS NULL OR EXISTS(SELECT 1 FROM ops.agent_steps s WHERE s.run_id=r.id AND s.meta->>'tool'=q->>'tool'))
        AND (nullif(q->>'changedAfter','') IS NULL OR r.updated_at>(q->>'changedAfter')::timestamptz)
      ORDER BY r.started_at DESC LIMIT size) r),'[]'),
    'counts',(SELECT jsonb_build_object('total',count(*),'running',count(*) FILTER(WHERE status='running'),
      'completed',count(*) FILTER(WHERE status='completed'),'failed',count(*) FILTER(WHERE status='failed'),
      'denied',count(*) FILTER(WHERE status='denied'),
      'byAssistant',jsonb_build_object('student',count(*) FILTER(WHERE assistant='student'),'officer',count(*) FILTER(WHERE assistant='officer'),
        'company',count(*) FILTER(WHERE assistant='company')),
      'medianMs',percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) FILTER(WHERE duration_ms IS NOT NULL))
      FROM ops.agent_runs WHERE expires_at>now()),
    'tools',coalesce((SELECT jsonb_agg(DISTINCT s.meta->>'tool') FROM ops.agent_steps s JOIN ops.agent_runs r ON r.id=s.run_id
      WHERE r.expires_at>now() AND s.meta ? 'tool'),'[]'),
    'serverTime',now());
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.';
END $$;
CREATE FUNCTION ops.agent_run(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r ops.agent_runs;
BEGIN
  PERFORM ops.assert_admin();
  SELECT * INTO r FROM ops.agent_runs WHERE id=target AND expires_at>now();
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='This run is not available. Runs are kept for 7 days.'; END IF;
  RETURN ops.run_json(r)||jsonb_build_object('steps',coalesce((SELECT jsonb_agg(jsonb_build_object('seq',s.seq,'parentSeq',s.parent_seq,
    'node',s.node,'kind',s.kind,'label',s.label,'status',s.status,'startedAt',s.started_at,'endedAt',s.ended_at,'durationMs',s.duration_ms,
    'attempt',s.attempt,'errorCategory',s.error_category,'meta',s.meta) ORDER BY s.seq) FROM ops.agent_steps s WHERE s.run_id=r.id),'[]'));
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ops FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.is_admin(),ops.assert_admin(),ops.trace_start(jsonb),ops.trace_steps(uuid,jsonb,jsonb),ops.agent_runs_list(jsonb),ops.agent_run(uuid) TO dsu_api;
NOTIFY pgrst,'reload schema';
