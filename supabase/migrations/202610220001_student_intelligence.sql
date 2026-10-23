-- Student Skills Intelligence (docs/STUDENT-INTELLIGENCE.md sections 2, 3, 5 and 6).
-- Additive only. One identity (erp.students.id); students write through
-- erp.actor_student(); the sync worker is recognised by app.sync_worker='on';
-- officers read only through SECURITY DEFINER functions owned by dsu_placement.
-- Platform tokens are stored as ciphertext only and are never readable unless
-- app.credential_access='on' is set by the backend for that transaction.

-- 1. Helpers --------------------------------------------------------------------
CREATE FUNCTION student.sync_worker() RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT coalesce(current_setting('app.sync_worker',true),'')='on'
$$;
CREATE FUNCTION student.credential_access() RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT coalesce(current_setting('app.credential_access',true),'')='on'
$$;
-- Keep equal to ONBOARDING_VERSION in src/modules/intelligence/constants.js.
CREATE FUNCTION student.onboarding_current_version() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT 1
$$;

-- 2. Tables ---------------------------------------------------------------------
CREATE TABLE student.skill_profiles(
  student_id uuid PRIMARY KEY REFERENCES erp.students(id) ON DELETE CASCADE,
  onboarding_version integer NOT NULL DEFAULT 0 CHECK(onboarding_version>=0),
  onboarding_completed_at timestamptz,
  identity_confirmed_at timestamptz,
  visibility_saved_at timestamptz,
  consent_version integer CHECK(consent_version>=1),
  consented_at timestamptz,
  visibility jsonb NOT NULL DEFAULT '{"platforms":true,"projects":true,"activity":true,"summary":true}'
    CHECK(jsonb_typeof(visibility)='object'),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE student.platform_accounts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK(platform IN ('github','leetcode','hackerrank','linkedin','huggingface','kaggle')),
  state text NOT NULL CHECK(state IN ('linked','declared_none','disconnected')),
  handle text CHECK(length(handle) BETWEEN 1 AND 100),
  profile_url text CHECK(profile_url IS NULL OR (length(profile_url)<=500 AND profile_url ~ '^https://[^[:space:]]+$')),
  auth_method text NOT NULL DEFAULT 'none' CHECK(auth_method IN ('github_app','github_pat','public_api','link_only','none')),
  ownership text NOT NULL DEFAULT 'unavailable' CHECK(ownership IN ('platform_verified','student_submitted','unavailable')),
  external_id text CHECK(length(external_id)<=100),
  submitted jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(submitted)='object'),
  visible boolean NOT NULL DEFAULT true,
  sync_status text NOT NULL DEFAULT 'not_applicable'
    CHECK(sync_status IN ('not_applicable','pending','running','completed','partial','failed','unavailable')),
  sync_error text CHECK(length(sync_error)<=500),
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  manual_refresh_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id,platform),
  -- Target for composite keys so child rows can never point at another student's account.
  UNIQUE(id,student_id)
);
-- One linked student per external platform identity.
CREATE UNIQUE INDEX platform_accounts_external ON student.platform_accounts(platform,external_id)
  WHERE external_id IS NOT NULL AND state='linked';

CREATE TABLE student.platform_credentials(
  account_id uuid PRIMARY KEY REFERENCES student.platform_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('github_user_token','github_pat')),
  key_id text NOT NULL CHECK(length(key_id) BETWEEN 1 AND 64),
  access_cipher text NOT NULL CHECK(length(access_cipher) BETWEEN 1 AND 8000),
  refresh_cipher text CHECK(length(refresh_cipher) BETWEEN 1 AND 8000),
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE student.platform_snapshots(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK(platform IN ('github','leetcode','hackerrank','linkedin','huggingface','kaggle')),
  status text NOT NULL CHECK(status IN ('completed','partial','failed','unavailable')),
  method text NOT NULL CHECK(length(method) BETWEEN 1 AND 100),
  payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object'),
  collected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,student_id) REFERENCES student.platform_accounts(id,student_id) ON DELETE CASCADE
);
CREATE INDEX platform_snapshots_account ON student.platform_snapshots(account_id,collected_at DESC);
CREATE INDEX platform_snapshots_student ON student.platform_snapshots(student_id);

CREATE TABLE student.platform_metrics(
  account_id uuid NOT NULL,
  metric text NOT NULL CHECK(length(metric) BETWEEN 1 AND 100),
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK(platform IN ('github','leetcode','hackerrank','linkedin','huggingface','kaggle')),
  value jsonb NOT NULL,
  verification text NOT NULL CHECK(verification IN ('institution_verified','platform_verified','student_submitted','ai_generated','unavailable')),
  method text NOT NULL CHECK(length(method) BETWEEN 1 AND 100),
  snapshot_id uuid REFERENCES student.platform_snapshots(id) ON DELETE SET NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK(length(note)<=500),
  PRIMARY KEY(account_id,metric),
  FOREIGN KEY(account_id,student_id) REFERENCES student.platform_accounts(id,student_id) ON DELETE CASCADE
);
CREATE INDEX platform_metrics_student ON student.platform_metrics(student_id);
CREATE INDEX platform_metrics_snapshot ON student.platform_metrics(snapshot_id);

CREATE TABLE student.github_repositories(
  account_id uuid NOT NULL,
  repo_id bigint NOT NULL,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  full_name text NOT NULL CHECK(length(full_name) BETWEEN 1 AND 300),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  url text NOT NULL CHECK(length(url)<=500 AND url ~ '^https://[^[:space:]]+$'),
  description text CHECK(length(description)<=2000),
  primary_language text CHECK(length(primary_language)<=100),
  languages jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(languages)='object'),
  topics jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(topics)='array'),
  stars integer NOT NULL DEFAULT 0 CHECK(stars>=0),
  forks integer NOT NULL DEFAULT 0 CHECK(forks>=0),
  is_fork boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  has_readme boolean,
  readme_bytes integer CHECK(readme_bytes>=0),
  license text CHECK(length(license)<=100),
  homepage text CHECK(length(homepage)<=500),
  pushed_at timestamptz,
  repo_updated_at timestamptz,
  owner_login text CHECK(length(owner_login)<=100),
  pinned boolean NOT NULL DEFAULT false,
  pin_order integer CHECK(pin_order BETWEEN 1 AND 6),
  recommendation_score integer,
  recommendation_reasons jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(recommendation_reasons)='array'),
  additions_52w integer CHECK(additions_52w>=0),
  snapshot_id uuid REFERENCES student.platform_snapshots(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,repo_id),
  FOREIGN KEY(account_id,student_id) REFERENCES student.platform_accounts(id,student_id) ON DELETE CASCADE
);
CREATE INDEX github_repositories_student ON student.github_repositories(student_id);
CREATE INDEX github_repositories_snapshot ON student.github_repositories(snapshot_id);

CREATE TABLE student.featured_projects(
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK(position BETWEEN 1 AND 3),
  account_id uuid NOT NULL,
  repo_id bigint NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(student_id,position),
  UNIQUE(student_id,repo_id),
  FOREIGN KEY(account_id,repo_id) REFERENCES student.github_repositories(account_id,repo_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,student_id) REFERENCES student.platform_accounts(id,student_id) ON DELETE CASCADE
);
CREATE INDEX featured_projects_repo ON student.featured_projects(account_id,repo_id);

CREATE TABLE student.profile_summaries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  model text NOT NULL CHECK(length(model) BETWEEN 1 AND 100),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  evidence jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(evidence)='array'),
  input_hash text NOT NULL CHECK(length(input_hash) BETWEEN 1 AND 128),
  -- Evidence groups the summary was built from ("platforms:<platform>", "projects",
  -- "activity"). placement.skill_profile withholds the summary from officers as soon
  -- as any of them is no longer shared, so a summary can never outlive a visibility change.
  sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sources)='array'),
  hidden boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profile_summaries_student ON student.profile_summaries(student_id,created_at DESC);

-- One row per summary generation attempt (recorded before the model is called, so
-- failed and concurrent attempts count against the hourly limit).
CREATE TABLE student.profile_summary_attempts(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profile_summary_attempts_student ON student.profile_summary_attempts(student_id,created_at DESC);

CREATE TABLE student.sync_jobs(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK(platform IN ('github','leetcode','hackerrank','linkedin','huggingface','kaggle')),
  reason text NOT NULL CHECK(reason IN ('connect','manual','scheduled','retry')),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','partial','failed','unavailable','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
  run_after timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  last_error text CHECK(length(last_error)<=1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,student_id) REFERENCES student.platform_accounts(id,student_id) ON DELETE CASCADE
);
CREATE INDEX sync_jobs_due ON student.sync_jobs(status,run_after);
CREATE INDEX sync_jobs_account ON student.sync_jobs(account_id,created_at DESC);
CREATE INDEX sync_jobs_student ON student.sync_jobs(student_id);
-- At most one queued or running job per account.
CREATE UNIQUE INDEX sync_jobs_one_open ON student.sync_jobs(account_id) WHERE status IN ('pending','running');

CREATE TABLE student.oauth_states(
  state_hash text PRIMARY KEY CHECK(length(state_hash) BETWEEN 32 AND 128),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  verifier_cipher text NOT NULL CHECK(length(verifier_cipher) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX oauth_states_user ON student.oauth_states(user_id,created_at DESC);
CREATE INDEX oauth_states_student ON student.oauth_states(student_id);
CREATE INDEX oauth_states_expiry ON student.oauth_states(expires_at);

-- Skill-profile status for officer views. 'complete' needs the current onboarding
-- version AND every required platform (keep in sync with REQUIRED_PLATFORMS in
-- constants.js) still linked or declared as not used; a later disconnect makes the
-- profile 'incomplete' again. No skill_profiles row means 'not_started'.
CREATE FUNCTION student.skill_status(target uuid) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT CASE WHEN p.student_id IS NULL THEN 'not_started'
    WHEN p.onboarding_version>=student.onboarding_current_version()
      AND (SELECT count(DISTINCT a.platform) FROM student.platform_accounts a
        WHERE a.student_id=target AND a.platform IN ('github','leetcode','hackerrank','linkedin')
          AND a.state IN ('linked','declared_none'))=4
    THEN 'complete' ELSE 'incomplete' END
  FROM (SELECT 1) one LEFT JOIN student.skill_profiles p ON p.student_id=target
$$;

-- 3. Row level security (dsu_api: students and the sync worker) ----------------
ALTER TABLE student.skill_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.platform_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.platform_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.platform_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.platform_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.github_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.featured_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.profile_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE student.profile_summary_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY skill_owner ON student.skill_profiles TO dsu_api
  USING(student_id=erp.actor_student()) WITH CHECK(student_id=erp.actor_student());
CREATE POLICY skill_worker_read ON student.skill_profiles FOR SELECT TO dsu_api USING(student.sync_worker());

CREATE POLICY account_owner ON student.platform_accounts TO dsu_api
  USING(student_id=erp.actor_student()) WITH CHECK(student_id=erp.actor_student());
CREATE POLICY account_worker_read ON student.platform_accounts FOR SELECT TO dsu_api USING(student.sync_worker());
CREATE POLICY account_worker_update ON student.platform_accounts FOR UPDATE TO dsu_api
  USING(student.sync_worker()) WITH CHECK(student.sync_worker());

-- Ciphertext is readable only with app.credential_access='on', and then only by the
-- owning student or the worker. UPDATE/DELETE with a WHERE clause also need the read
-- policy, so the backend sets app.credential_access for those statements too.
CREATE POLICY credential_read ON student.platform_credentials FOR SELECT TO dsu_api
  USING(student.credential_access() AND (student.sync_worker() OR EXISTS(SELECT 1 FROM student.platform_accounts a
    WHERE a.id=platform_credentials.account_id AND a.student_id=erp.actor_student())));
CREATE POLICY credential_owner_insert ON student.platform_credentials FOR INSERT TO dsu_api
  WITH CHECK(EXISTS(SELECT 1 FROM student.platform_accounts a
    WHERE a.id=platform_credentials.account_id AND a.student_id=erp.actor_student()));
CREATE POLICY credential_owner_update ON student.platform_credentials FOR UPDATE TO dsu_api
  USING(EXISTS(SELECT 1 FROM student.platform_accounts a WHERE a.id=platform_credentials.account_id AND a.student_id=erp.actor_student()))
  WITH CHECK(EXISTS(SELECT 1 FROM student.platform_accounts a WHERE a.id=platform_credentials.account_id AND a.student_id=erp.actor_student()));
CREATE POLICY credential_owner_delete ON student.platform_credentials FOR DELETE TO dsu_api
  USING(EXISTS(SELECT 1 FROM student.platform_accounts a WHERE a.id=platform_credentials.account_id AND a.student_id=erp.actor_student()));
CREATE POLICY credential_worker_update ON student.platform_credentials FOR UPDATE TO dsu_api
  USING(student.sync_worker()) WITH CHECK(student.sync_worker());

CREATE POLICY snapshot_owner_read ON student.platform_snapshots FOR SELECT TO dsu_api USING(student_id=erp.actor_student());
CREATE POLICY snapshot_worker ON student.platform_snapshots TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());

CREATE POLICY metric_owner_read ON student.platform_metrics FOR SELECT TO dsu_api USING(student_id=erp.actor_student());
CREATE POLICY metric_worker ON student.platform_metrics TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());

CREATE POLICY repository_owner_read ON student.github_repositories FOR SELECT TO dsu_api USING(student_id=erp.actor_student());
CREATE POLICY repository_worker ON student.github_repositories TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());

CREATE POLICY featured_owner ON student.featured_projects TO dsu_api
  USING(student_id=erp.actor_student()) WITH CHECK(student_id=erp.actor_student());
CREATE POLICY featured_worker_read ON student.featured_projects FOR SELECT TO dsu_api USING(student.sync_worker());

CREATE POLICY summary_owner_read ON student.profile_summaries FOR SELECT TO dsu_api USING(student_id=erp.actor_student());
CREATE POLICY summary_owner_insert ON student.profile_summaries FOR INSERT TO dsu_api WITH CHECK(student_id=erp.actor_student());
CREATE POLICY summary_owner_update ON student.profile_summaries FOR UPDATE TO dsu_api
  USING(student_id=erp.actor_student()) WITH CHECK(student_id=erp.actor_student());

CREATE POLICY summary_attempt_owner_read ON student.profile_summary_attempts FOR SELECT TO dsu_api USING(student_id=erp.actor_student());
CREATE POLICY summary_attempt_owner_insert ON student.profile_summary_attempts FOR INSERT TO dsu_api WITH CHECK(student_id=erp.actor_student());

CREATE POLICY job_owner_read ON student.sync_jobs FOR SELECT TO dsu_api USING(student_id=erp.actor_student());
CREATE POLICY job_owner_insert ON student.sync_jobs FOR INSERT TO dsu_api WITH CHECK(student_id=erp.actor_student());
CREATE POLICY job_worker ON student.sync_jobs TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());

CREATE POLICY oauth_owner ON student.oauth_states TO dsu_api
  USING(user_id=erp.actor_id()) WITH CHECK(user_id=erp.actor_id() AND student_id=erp.actor_student());

REVOKE ALL ON student.skill_profiles,student.platform_accounts,student.platform_credentials,student.platform_snapshots,
  student.platform_metrics,student.github_repositories,student.featured_projects,student.profile_summaries,
  student.sync_jobs,student.oauth_states,student.profile_summary_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON student.skill_profiles,student.platform_accounts,student.platform_credentials,
  student.platform_snapshots,student.platform_metrics,student.github_repositories,student.featured_projects,
  student.sync_jobs,student.oauth_states TO dsu_api;
-- Students may only review or hide a stored summary, never rewrite its content.
GRANT SELECT,INSERT ON student.profile_summaries TO dsu_api;
GRANT UPDATE(hidden,reviewed_at) ON student.profile_summaries TO dsu_api;
-- Attempts are append-only for students.
GRANT SELECT,INSERT ON student.profile_summary_attempts TO dsu_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA student TO dsu_api;

-- Officers: read only, never credentials or OAuth state.
GRANT USAGE ON SCHEMA student TO dsu_placement;
GRANT SELECT ON student.skill_profiles,student.platform_accounts,student.platform_metrics,student.github_repositories,
  student.featured_projects,student.profile_summaries TO dsu_placement;
CREATE POLICY officer_read ON student.skill_profiles FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON student.platform_accounts FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON student.platform_metrics FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON student.github_repositories FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON student.featured_projects FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON student.profile_summaries FOR SELECT TO dsu_placement USING(placement.authorized());

REVOKE ALL ON FUNCTION student.sync_worker(),student.credential_access(),student.onboarding_current_version(),
  student.skill_status(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.sync_worker(),student.credential_access(),student.onboarding_current_version(),
  student.skill_status(uuid) TO dsu_api;
GRANT EXECUTE ON FUNCTION student.onboarding_current_version(),student.skill_status(uuid) TO dsu_placement;

-- 4. Ranking --------------------------------------------------------------------
-- Dense rank by official CGPA within the passing-out batch (and category within it).
-- Unclassified students are returned with NULL ranks. NULL batch = every batch,
-- still partitioned by batch. Runs as the caller, so callers must see every row.
CREATE FUNCTION erp.cgpa_ranks(batch text) RETURNS TABLE(
  student_id uuid,batch text,cgpa numeric,category text,batch_rank integer,category_rank integer,batch_size integer,category_size integer
) LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT b.id,b.source_batch,b.cgpa,b.category,
    (CASE WHEN b.category IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.source_batch,b.category IS NULL ORDER BY b.cgpa DESC) END)::integer,
    (CASE WHEN b.category IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.source_batch,b.category ORDER BY b.cgpa DESC) END)::integer,
    (count(*) FILTER(WHERE b.category IS NOT NULL) OVER(PARTITION BY b.source_batch))::integer,
    (CASE WHEN b.category IS NOT NULL THEN count(*) OVER(PARTITION BY b.source_batch,b.category) END)::integer
  FROM (SELECT s.id,s.source_batch,a.cgpa,erp.cgpa_category(a.cgpa) AS category
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
    WHERE $1 IS NULL OR s.source_batch=$1) b
$$;
REVOKE ALL ON FUNCTION erp.cgpa_ranks(text) FROM PUBLIC,anon,authenticated;
-- Not granted to dsu_api: under student RLS it would rank a student against only
-- themselves. Students use student.my_ranking(); officers use placement.* below.
GRANT EXECUTE ON FUNCTION erp.cgpa_ranks(text) TO dsu_placement;

-- Owned by the migration runner so it can rank against the whole batch, but it only
-- ever returns the calling student's own position.
CREATE FUNCTION student.my_ranking() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me uuid:=erp.actor_student(); my_batch text; r record;
BEGIN
  IF me IS NULL THEN RAISE SQLSTATE 'PT403' USING MESSAGE='A linked student record is required.'; END IF;
  SELECT s.source_batch INTO my_batch FROM erp.students s WHERE s.id=me;
  SELECT x.* INTO r FROM erp.cgpa_ranks(my_batch) x WHERE x.student_id=me;
  RETURN jsonb_build_object('batch',my_batch,'category',r.category,'batchRank',r.batch_rank,'categoryRank',r.category_rank,
    'batchSize',r.batch_size,'categorySize',r.category_size,'scope','batch');
END $$;
REVOKE ALL ON FUNCTION student.my_ranking() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.my_ranking() TO dsu_api;

-- 5. Officer helpers (run as the caller, i.e. dsu_placement inside officer RPCs) --
-- Validates the shape shared by the officer functions and drops empty/null values.
CREATE FUNCTION placement.intel_filters(q jsonb,allowed text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
  IF q IS NULL OR q='null'::jsonb THEN RETURN '{}'::jsonb; END IF;
  IF jsonb_typeof(q)<>'object' OR octet_length(q::text)>4000
    OR EXISTS(SELECT 1 FROM jsonb_each(q) e WHERE e.key<>ALL(allowed) OR jsonb_typeof(e.value) NOT IN ('string','null')) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.';
  END IF;
  q:=coalesce((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(q) e
    WHERE jsonb_typeof(e.value)='string' AND btrim(e.value#>>'{}')<>''),'{}'::jsonb);
  IF (q ? 'batch' AND q->>'batch' !~ '^20[0-9]{2}$')
    OR length(coalesce(q->>'department',''))>200 OR length(coalesce(q->>'search',''))>100
    OR length(coalesce(q->>'name',''))>100 OR length(coalesce(q->>'usn',''))>50
    OR (q ? 'page' AND q->>'page' !~ '^[1-9][0-9]{0,5}$')
    OR (q ? 'limit' AND q->>'limit' !~ '^[1-9][0-9]{0,2}$') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.';
  END IF;
  RETURN q;
END $$;
-- Smallest passing-out batch from the current year (Asia/Kolkata) on, else the latest one.
CREATE FUNCTION placement.default_batch() RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT coalesce(
    (SELECT min(s.source_batch) FROM erp.students s
      WHERE s.source_batch>=extract(year FROM now() AT TIME ZONE 'Asia/Kolkata')::integer::text),
    (SELECT max(s.source_batch) FROM erp.students s))
$$;
CREATE FUNCTION placement.repo_card(r student.github_repositories,include_url boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT jsonb_build_object('name',r.name,'fullName',r.full_name,'url',r.url,'description',r.description,
    'primaryLanguage',r.primary_language,'stars',r.stars,'pushedAt',r.pushed_at,'hasReadme',r.has_readme)
    - CASE WHEN include_url THEN '' ELSE 'url' END
$$;
REVOKE ALL ON FUNCTION placement.intel_filters(jsonb,text[]),placement.default_batch(),
  placement.repo_card(student.github_repositories,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION placement.intel_filters(jsonb,text[]),placement.default_batch(),
  placement.repo_card(student.github_repositories,boolean) TO dsu_placement;

-- 6. Officer RPCs (SECURITY DEFINER, owned by dsu_placement, officer-guarded) ----
CREATE FUNCTION placement.ranked_students(q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE actor uuid; f jsonb; sel_batch text; sel_category text; sort_key text; dir text;
  page_no integer; size integer; exporting boolean; n integer; rows_json jsonb;
BEGIN
  actor:=placement.assert_officer();
  f:=placement.intel_filters(q,ARRAY['batch','category','department','search','eligibility','skill','sort','direction','page','limit','export']);
  sel_category:=f->>'category';
  IF sel_category IS NULL OR sel_category NOT IN ('advanced','medium','needs-improvement') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Choose a valid category.';
  END IF;
  IF coalesce(f->>'eligibility','eligible') NOT IN ('eligible','ineligible')
    OR coalesce(f->>'skill','complete') NOT IN ('complete','incomplete','not_started')
    OR coalesce(f->>'sort','rank') NOT IN ('rank','name','usn','cgpa')
    OR coalesce(f->>'direction','asc') NOT IN ('asc','desc')
    OR coalesce(f->>'export','false') NOT IN ('true','false') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.';
  END IF;
  sort_key:=coalesce(f->>'sort','rank');
  dir:=coalesce(f->>'direction',CASE WHEN sort_key='cgpa' THEN 'desc' ELSE 'asc' END);
  page_no:=coalesce((f->>'page')::integer,1);
  size:=coalesce((f->>'limit')::integer,25);
  IF size>100 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid pagination.'; END IF;
  exporting:=f->>'export'='true';
  IF exporting THEN
    -- Same budget and audit trail as public.dsu_placement_read exports.
    PERFORM pg_advisory_xact_lock(hashtext('placement.export'),hashtext(actor::text));
    IF (SELECT count(*) FROM placement.events e WHERE e.actor_id=actor AND e.action='export'
      AND e.created_at>now()-interval '1 minute')>=5 THEN
      RAISE SQLSTATE 'PT429' USING MESSAGE='Please wait before exporting again.';
    END IF;
    page_no:=1; size:=20000;
  END IF;
  sel_batch:=coalesce(f->>'batch',placement.default_batch());

  -- Ranks are computed over the whole batch first; filters only hide rows.
  WITH filtered AS MATERIALIZED(
    SELECT s.id,s.enrollment_no AS usn,s.full_name AS name,s.department_short_name AS department,s.source_batch AS batch,
      s.current_semester AS semester,r.cgpa,r.category,erp.placement_eligible(r.cgpa) AS eligible,
      r.category_rank,r.batch_rank,student.skill_status(s.id) AS skill_status
    FROM erp.cgpa_ranks(sel_batch) r JOIN erp.students s ON s.id=r.student_id
    WHERE r.batch=sel_batch AND r.category=sel_category
      AND (f->>'department' IS NULL OR coalesce(s.department_short_name,'__missing__')=f->>'department')
      AND (f->>'search' IS NULL OR strpos(lower(s.full_name),lower(f->>'search'))>0
        OR strpos(lower(s.enrollment_no),lower(f->>'search'))>0)
      AND (f->>'eligibility' IS NULL OR CASE f->>'eligibility' WHEN 'eligible' THEN erp.placement_eligible(r.cgpa) IS TRUE
        ELSE erp.placement_eligible(r.cgpa) IS FALSE END)
      AND (f->>'skill' IS NULL OR student.skill_status(s.id)=f->>'skill')),
  ordered AS(
    SELECT t.*,row_number() OVER(ORDER BY
      CASE WHEN dir='asc' THEN CASE sort_key WHEN 'rank' THEN t.category_rank::numeric WHEN 'cgpa' THEN t.cgpa END END ASC NULLS LAST,
      CASE WHEN dir='desc' THEN CASE sort_key WHEN 'rank' THEN t.category_rank::numeric WHEN 'cgpa' THEN t.cgpa END END DESC NULLS LAST,
      (CASE WHEN dir='asc' THEN CASE sort_key WHEN 'name' THEN lower(t.name) WHEN 'usn' THEN t.usn END END) COLLATE "C" ASC NULLS LAST,
      (CASE WHEN dir='desc' THEN CASE sort_key WHEN 'name' THEN lower(t.name) WHEN 'usn' THEN t.usn END END) COLLATE "C" DESC NULLS LAST,
      t.category_rank,t.usn COLLATE "C",t.id) AS ord
    FROM filtered t)
  SELECT (SELECT count(*) FROM filtered),
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'usn',o.usn,'name',o.name,'department',o.department,'batch',o.batch,
      'semester',o.semester,'cgpa',o.cgpa::text,'category',o.category,'eligible',o.eligible,'categoryRank',o.category_rank,
      'batchRank',o.batch_rank,'skillStatus',o.skill_status,'profileUrl','/placement/students/'||o.id::text) ORDER BY o.ord)
      FROM (SELECT * FROM ordered x ORDER BY x.ord LIMIT size OFFSET (page_no-1)*size) o),'[]'::jsonb)
  INTO n,rows_json;

  IF exporting THEN
    IF n>20000 THEN RAISE SQLSTATE 'PT413' USING MESSAGE='Narrow the report to at most 20,000 rows.'; END IF;
    INSERT INTO placement.events(actor_id,action,details)
      VALUES(actor,'export',jsonb_build_object('resource','ranked_students','rows',n,'batch',sel_batch,'category',sel_category));
  END IF;
  RETURN jsonb_build_object('data',jsonb_build_object('rows',rows_json,
    'pagination',jsonb_build_object('total',n,'page',page_no,'limit',size),
    'scope',jsonb_build_object('batch',sel_batch,'category',sel_category,
      'rule','Dense rank by official CGPA within the passing-out batch and category. Filters do not change ranks.')));
END $$;

CREATE FUNCTION placement.category_cards(q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE f jsonb; sel_batch text; payload jsonb;
BEGIN
  PERFORM placement.assert_officer();
  f:=placement.intel_filters(q,ARRAY['batch','department']);
  sel_batch:=coalesce(f->>'batch',placement.default_batch());
  WITH cohort AS MATERIALIZED(
    SELECT s.id,a.cgpa,erp.cgpa_category(a.cgpa) AS category,erp.placement_eligible(a.cgpa) AS eligible
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
    WHERE s.source_batch=sel_batch
      AND (f->>'department' IS NULL OR coalesce(s.department_short_name,'__missing__')=f->>'department')),
  totals AS(SELECT count(*)::integer AS total,count(*) FILTER(WHERE c.category IS NULL)::integer AS unclassified FROM cohort c)
  SELECT jsonb_build_object('batch',sel_batch,
    'batches',coalesce((SELECT jsonb_agg(x.b ORDER BY x.b DESC) FROM (SELECT DISTINCT s.source_batch AS b FROM erp.students s) x),'[]'::jsonb),
    'departments',coalesce((SELECT jsonb_agg(x.d ORDER BY x.d) FROM (SELECT DISTINCT s.department_short_name AS d FROM erp.students s
      WHERE s.source_batch=sel_batch AND s.department_short_name IS NOT NULL) x),'[]'::jsonb),
    'total',t.total,'unclassified',t.unclassified,
    'cards',(SELECT jsonb_agg(jsonb_build_object('id',r.rule->>'id','name',r.rule->>'name','range',r.rule->>'displayRange',
        'total',k.cnt,'cohortPercentage',coalesce(round(100.0*k.cnt/nullif(t.total,0),1),0),
        'averageCgpa',round(k.average,2)::text,'eligible',k.eligible,
        'eligibilityPercentage',round(100.0*k.eligible/nullif(k.cnt,0),1)) ORDER BY r.ord)
      FROM jsonb_array_elements(erp.cgpa_rules()) WITH ORDINALITY r(rule,ord)
      CROSS JOIN LATERAL(SELECT count(*)::integer AS cnt,avg(c.cgpa) AS average,
        count(*) FILTER(WHERE c.eligible IS TRUE)::integer AS eligible FROM cohort c WHERE c.category=r.rule->>'id') k))
  INTO payload FROM totals t;
  RETURN jsonb_build_object('data',payload);
END $$;

CREATE FUNCTION placement.overview_charts(q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE f jsonb; payload jsonb;
BEGIN
  PERFORM placement.assert_officer();
  -- Empty batch means every batch here (no default).
  f:=placement.intel_filters(q,ARRAY['batch','department']);
  WITH students AS MATERIALIZED(SELECT c.id,c.department,c.cgpa,c.category,c.eligible FROM placement.cohort(f) c),
  active AS MATERIALIZED(SELECT o.* FROM placement.offer_facts(f||'{"inactive":"false"}'::jsonb) o),
  recorded AS MATERIALIZED(SELECT o.* FROM placement.offer_facts(f||'{"inactive":"true"}'::jsonb) o),
  placed AS MATERIALIZED(SELECT a.student_id,min(a.created_at) AS first_at FROM active a GROUP BY a.student_id),
  drives AS MATERIALIZED(SELECT d.* FROM placement.drives d WHERE f->>'batch' IS NULL OR d.batch=f->>'batch'),
  events AS(
    SELECT date_trunc('month',o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS m FROM recorded o
    UNION ALL SELECT date_trunc('month',d.drive_date)::date FROM drives d WHERE d.status='completed' AND d.drive_date IS NOT NULL),
  bounds AS(SELECT date_trunc('month',now() AT TIME ZONE 'Asia/Kolkata')::date AS cur,(SELECT min(e.m) FROM events e) AS first),
  months AS(SELECT g::date AS m FROM bounds b,
    generate_series(greatest(b.first,(b.cur-interval '23 months')::date)::timestamp,b.cur::timestamp,interval '1 month') g
    WHERE b.first IS NOT NULL),
  k AS(SELECT
    (SELECT count(*) FROM students)::integer AS total,
    (SELECT count(*) FROM students s WHERE s.eligible IS TRUE)::integer AS eligible,
    (SELECT count(*) FROM placed)::integer AS placed,
    (SELECT count(*) FROM placed p JOIN students s ON s.id=p.student_id WHERE s.eligible IS TRUE)::integer AS eligible_placed,
    (SELECT count(DISTINCT d.company_id) FROM drives d)::integer AS companies,
    (SELECT count(*) FROM drives d WHERE d.status IN ('upcoming','ongoing'))::integer AS active_drives,
    (SELECT count(*) FROM active a WHERE a.status='accepted')::integer AS accepted,
    (SELECT count(*) FROM active)::integer AS active_offers,
    (SELECT round(avg(s.cgpa) FILTER(WHERE s.category IS NOT NULL),2) FROM students s) AS average)
  SELECT jsonb_build_object(
    'filters',jsonb_build_object('batch',f->>'batch','department',f->>'department'),
    'kpis',jsonb_build_object('totalStudents',k.total,'eligible',k.eligible,'placed',k.placed,
      'placementRate',round(100.0*k.placed/nullif(k.total,0),2),'eligiblePlaced',k.eligible_placed,
      'eligiblePlacementRate',round(100.0*k.eligible_placed/nullif(k.eligible,0),2),'companies',k.companies,
      'activeDrives',k.active_drives,'acceptedOffers',k.accepted,'activeOffers',k.active_offers,'averageCgpa',k.average::text),
    'progress',coalesce((SELECT jsonb_agg(jsonb_build_object('month',to_char(mo.m,'YYYY-MM'),
        'studentsPlaced',(SELECT count(*) FROM placed p WHERE date_trunc('month',p.first_at AT TIME ZONE 'Asia/Kolkata')::date=mo.m),
        'offersRecorded',(SELECT count(*) FROM recorded o WHERE date_trunc('month',o.created_at AT TIME ZONE 'Asia/Kolkata')::date=mo.m),
        'drivesCompleted',(SELECT count(*) FROM drives d WHERE d.status='completed' AND date_trunc('month',d.drive_date)::date=mo.m))
      ORDER BY mo.m) FROM months mo),'[]'::jsonb),
    'status',jsonb_build_array(
      jsonb_build_object('key','placed','label','Placed','count',k.placed),
      jsonb_build_object('key','eligible_not_placed','label','Eligible, not placed','count',
        (SELECT count(*) FROM students s WHERE s.eligible IS TRUE AND NOT EXISTS(SELECT 1 FROM placed p WHERE p.student_id=s.id))),
      jsonb_build_object('key','not_eligible_not_placed','label','Not eligible, not placed','count',
        (SELECT count(*) FROM students s WHERE s.eligible IS FALSE AND NOT EXISTS(SELECT 1 FROM placed p WHERE p.student_id=s.id))),
      jsonb_build_object('key','unknown_not_placed','label','CGPA unknown, not placed','count',
        (SELECT count(*) FROM students s WHERE s.eligible IS NULL AND NOT EXISTS(SELECT 1 FROM placed p WHERE p.student_id=s.id)))),
    'departments',coalesce((SELECT jsonb_agg(jsonb_build_object('department',x.department,'total',x.total,'eligible',x.eligible,'placed',x.placed)
        ORDER BY x.department NULLS LAST)
      FROM (SELECT s.department,count(*) AS total,count(*) FILTER(WHERE s.eligible IS TRUE) AS eligible,
        count(p.student_id) AS placed FROM students s LEFT JOIN placed p ON p.student_id=s.id GROUP BY s.department) x),'[]'::jsonb),
    'definitions',jsonb_build_object(
      'totalStudents','Students in the selected cohort (passing-out batch and department filters).',
      'eligible','Students with a valid CGPA of 6.75 or above.',
      'placed','Distinct students in the cohort holding at least one active offer (offered or accepted). Declined and revoked offers do not count.',
      'placementRate','Students placed divided by total students, as a percentage with 2 decimals.',
      'eligiblePlaced','Placement eligible students who are placed.',
      'eligiblePlacementRate','Eligible students placed divided by eligible students, as a percentage with 2 decimals.',
      'companies','Companies with at least one drive for the selected batch. The department filter does not apply to drives or companies.',
      'activeDrives','Drives for the selected batch with status upcoming or ongoing. The department filter does not apply to drives.',
      'acceptedOffers','Offers to students in the cohort with status accepted.',
      'activeOffers','Offers to students in the cohort with status offered or accepted.',
      'averageCgpa','Mean of valid CGPAs in the cohort, rounded to 2 decimals.',
      'progress','Monthly line chart (Asia/Kolkata) from the first month with data to the current month, at most the latest 24 months. Students placed counts each student once, in the month their first active offer was recorded. Offers recorded counts offers of any status. Dates are the month an offer was recorded in the ERP, because no real offer date is stored. Drives completed counts completed drives by drive date.',
      'status','Donut chart: placed, eligible not placed, not eligible not placed, and CGPA unknown not placed. The four segments add up to total students.',
      'departments','Bar chart per department: total students, placement eligible students and students placed.'))
  INTO payload FROM k;
  RETURN jsonb_build_object('data',payload);
END $$;

CREATE FUNCTION placement.student_core(id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE target uuid:=$1; payload jsonb;
BEGIN
  PERFORM placement.assert_officer();
  -- Identity, academics and placement summary only. Never erp.contacts.
  SELECT jsonb_build_object('id',s.id,'usn',s.enrollment_no,'name',s.full_name,'department',s.department_short_name,
    'departmentName',s.department_name,'program',s.course_name,'batch',s.source_batch,'semester',s.current_semester,
    'cgpa',a.cgpa::text,'sgpa',a.sgpa::text,'attendance',a.attendance::text,'backlogs',a.current_backlog,
    'category',erp.cgpa_category(a.cgpa),
    'categoryLabel',(SELECT rule->>'name' FROM jsonb_array_elements(erp.cgpa_rules()) rule WHERE rule->>'id'=erp.cgpa_category(a.cgpa)),
    'eligible',erp.placement_eligible(a.cgpa),
    'ranking',coalesce((SELECT jsonb_build_object('batchRank',r.batch_rank,'categoryRank',r.category_rank,'batchSize',r.batch_size,
      'categorySize',r.category_size,'scope','batch') FROM erp.cgpa_ranks(s.source_batch) r WHERE r.student_id=s.id),
      jsonb_build_object('batchRank',NULL,'categoryRank',NULL,'batchSize',NULL,'categorySize',NULL,'scope','batch')),
    'placement',(SELECT jsonb_build_object(
      'activeOffers',count(*) FILTER(WHERE o.status IN ('offered','accepted')),
      'acceptedOffers',count(*) FILTER(WHERE o.status='accepted'),
      'highestPackageLpa',(max(o.package_lpa) FILTER(WHERE o.status IN ('offered','accepted')))::text,
      'placed',count(*) FILTER(WHERE o.status IN ('offered','accepted'))>0)
      FROM placement.offers o JOIN placement.registrations g ON g.id=o.registration_id WHERE g.student_id=s.id),
    'skillStatus',student.skill_status(s.id),
    'provenance','institution_verified')
  INTO payload FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id WHERE s.id=target;
  IF payload IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Student not found.'; END IF;
  RETURN payload;
END $$;

CREATE FUNCTION placement.skill_profile(id uuid,purpose text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE target uuid:=$1; mode text:=$2; for_ai boolean; stored jsonb; version integer; completed timestamptz; vis jsonb;
  consented boolean; github_shared boolean; summary_sources jsonb; withheld boolean:=false;
  accounts_json jsonb; featured_json jsonb:='[]'; repos_json jsonb:='[]'; activity_json jsonb:='[]'; summary_json jsonb;
BEGIN
  PERFORM placement.assert_officer();
  IF mode IS NULL OR mode NOT IN ('officer','ai') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid purpose.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM erp.students s WHERE s.id=target) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Student not found.'; END IF;
  for_ai:=mode='ai';
  SELECT p.visibility,p.onboarding_version,p.onboarding_completed_at,coalesce(p.consent_version,0)>=1
    INTO stored,version,completed,consented
    FROM student.skill_profiles p WHERE p.student_id=target;
  stored:=coalesce(stored,'{}'::jsonb);
  -- Consent is given when the student completes onboarding. Until then officers
  -- see only onboarding status and per-platform state, never student-provided data.
  consented:=coalesce(consented,false);
  -- Anything other than an explicit true counts as hidden once a value is stored.
  vis:=jsonb_build_object(
    'platforms',coalesce(stored->'platforms','true'::jsonb)='true'::jsonb,
    'projects',coalesce(stored->'projects','true'::jsonb)='true'::jsonb,
    'activity',coalesce(stored->'activity','true'::jsonb)='true'::jsonb,
    'summary',coalesce(stored->'summary','true'::jsonb)='true'::jsonb);

  SELECT coalesce(jsonb_agg(CASE WHEN a.state<>'linked' OR NOT consented OR NOT (vis->>'platforms')::boolean
      THEN jsonb_build_object('platform',a.platform,'state',a.state)
      ELSE jsonb_build_object('platform',a.platform,'state',a.state,'handle',a.handle,'profileUrl',a.profile_url,
        'authMethod',a.auth_method,'ownership',a.ownership,'syncStatus',a.sync_status,'lastSyncedAt',a.last_synced_at,
        'metrics',coalesce((SELECT jsonb_agg(jsonb_build_object('metric',m.metric,'value',m.value,'verification',m.verification,
            'method',m.method,'collectedAt',m.collected_at,'note',m.note) ORDER BY m.metric)
          FROM student.platform_metrics m WHERE m.account_id=a.id
            AND m.metric NOT LIKE 'activity.%' AND m.metric NOT LIKE 'contributions.%'),'[]'::jsonb),
        'submitted',CASE WHEN for_ai AND jsonb_typeof(a.submitted->'certifications')='array'
          THEN jsonb_set(a.submitted,'{certifications}',(SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(c)='object' THEN c-'url' ELSE c END),'[]'::jsonb)
            FROM jsonb_array_elements(a.submitted->'certifications') c))
          ELSE a.submitted END) END
    ORDER BY array_position(ARRAY['github','leetcode','hackerrank','linkedin','huggingface','kaggle'],a.platform)),'[]'::jsonb)
  INTO accounts_json FROM student.platform_accounts a WHERE a.student_id=target AND a.visible;

  IF NOT consented THEN
    RETURN jsonb_build_object('visibility',vis,
      'onboarding',jsonb_build_object('complete',coalesce(version,0)>=student.onboarding_current_version(),
        'completedAt',completed,'consented',false),
      'accounts',accounts_json,'featured','[]'::jsonb,'repositories','[]'::jsonb,'activity','[]'::jsonb,
      'summary',NULL,'summaryWithheld',false);
  END IF;

  github_shared:=EXISTS(SELECT 1 FROM student.platform_accounts a
    WHERE a.student_id=target AND a.platform='github' AND a.state='linked' AND a.visible);

  IF (vis->>'projects')::boolean THEN
    WITH gh AS(SELECT a.id FROM student.platform_accounts a
      WHERE a.student_id=target AND a.platform='github' AND a.state='linked' AND a.visible),
    candidates AS(
      SELECT r AS repo,r.repo_id,'github_pinned'::text AS source,0 AS grp,r.pin_order AS ord
        FROM student.github_repositories r JOIN gh ON gh.id=r.account_id WHERE r.pinned
      UNION ALL
      SELECT r,r.repo_id,'student_selected',1,fp.position
        FROM student.featured_projects fp JOIN student.github_repositories r ON r.account_id=fp.account_id AND r.repo_id=fp.repo_id
        JOIN gh ON gh.id=r.account_id WHERE fp.student_id=target),
    dedup AS(SELECT DISTINCT ON(c.repo_id) c.* FROM candidates c ORDER BY c.repo_id,c.grp,c.ord NULLS LAST),
    top3 AS(SELECT d.*,row_number() OVER(ORDER BY d.grp,d.ord NULLS LAST,d.repo_id) AS pos FROM dedup d ORDER BY pos LIMIT 3)
    SELECT coalesce(jsonb_agg(jsonb_build_object('position',t.pos,'source',t.source,'repo',placement.repo_card(t.repo,NOT for_ai)) ORDER BY t.pos),'[]'::jsonb)
    INTO featured_json FROM top3 t;

    SELECT coalesce(jsonb_agg(placement.repo_card(t.repo,NOT for_ai)||jsonb_build_object('recommendationScore',(t.repo).recommendation_score,
        'recommendationReasons',(t.repo).recommendation_reasons) ORDER BY t.pos),'[]'::jsonb)
    INTO repos_json FROM (SELECT r AS repo,row_number() OVER(ORDER BY r.recommendation_score DESC NULLS LAST,r.stars DESC,r.repo_id) AS pos
      FROM student.github_repositories r JOIN student.platform_accounts a ON a.id=r.account_id
      WHERE a.student_id=target AND a.platform='github' AND a.state='linked' AND a.visible
      ORDER BY pos LIMIT 6) t;
  END IF;

  IF (vis->>'activity')::boolean THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('metric',m.metric,'value',m.value,'verification',m.verification,
        'method',m.method,'collectedAt',m.collected_at,'note',m.note) ORDER BY m.metric),'[]'::jsonb)
    INTO activity_json FROM student.platform_metrics m JOIN student.platform_accounts a ON a.id=m.account_id
    WHERE a.student_id=target AND a.platform='github' AND a.state='linked' AND a.visible
      AND (m.metric LIKE 'activity.%' OR m.metric LIKE 'contributions.%');
  END IF;

  IF (vis->>'summary')::boolean THEN
    SELECT jsonb_build_object('id',x.id,'createdAt',x.created_at,'model',x.model,'content',x.content,
      'evidence',x.evidence,'reviewedAt',x.reviewed_at),x.sources
    INTO summary_json,summary_sources FROM student.profile_summaries x WHERE x.student_id=target AND NOT x.hidden
    ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
    -- Withhold the summary when any evidence group it used is no longer shared
    -- (a visibility toggle, a hidden account, or a disconnected or declared platform).
    -- Unknown groups fail closed.
    IF summary_json IS NOT NULL AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(summary_sources) src(v)
      WHERE NOT coalesce(CASE
        WHEN jsonb_typeof(src.v)<>'string' THEN false
        WHEN src.v#>>'{}'='projects' THEN (vis->>'projects')::boolean AND github_shared
        WHEN src.v#>>'{}'='activity' THEN (vis->>'activity')::boolean AND github_shared
        WHEN src.v#>>'{}' LIKE 'platforms:%' THEN (vis->>'platforms')::boolean AND EXISTS(SELECT 1 FROM student.platform_accounts a
          WHERE a.student_id=target AND a.platform=substr(src.v#>>'{}',11) AND a.state='linked' AND a.visible)
        ELSE false END,false)) THEN
      summary_json:=NULL;
      withheld:=true;
    END IF;
  END IF;

  RETURN jsonb_build_object('visibility',vis,
    'onboarding',jsonb_build_object('complete',coalesce(version,0)>=student.onboarding_current_version(),
      'completedAt',completed,'consented',true),
    'accounts',accounts_json,'featured',featured_json,'repositories',repos_json,'activity',activity_json,
    'summary',summary_json,'summaryWithheld',withheld);
END $$;

CREATE FUNCTION placement.lookup_students(q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE f jsonb; usn_q text; name_q text; matches jsonb;
BEGIN
  PERFORM placement.assert_officer();
  f:=placement.intel_filters(q,ARRAY['usn','name']);
  usn_q:=upper(btrim(f->>'usn'));
  name_q:=lower(btrim(f->>'name'));
  IF length(name_q)<3 THEN name_q:=NULL; END IF;
  IF usn_q IS NULL AND name_q IS NULL THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Provide a USN or at least 3 characters of a name.';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'usn',m.usn,'name',m.name,'department',m.department,'batch',m.batch,
      'profileUrl','/placement/students/'||m.id::text,'exact',m.exact) ORDER BY m.ord),'[]'::jsonb)
  INTO matches FROM (
    SELECT s.id,s.enrollment_no AS usn,s.full_name AS name,s.department_short_name AS department,s.source_batch AS batch,
      coalesce(upper(s.enrollment_no)=usn_q,false) AS exact,
      row_number() OVER(ORDER BY coalesce(upper(s.enrollment_no)=usn_q,false) DESC,lower(s.full_name),s.enrollment_no COLLATE "C",s.id) AS ord
    FROM erp.students s
    WHERE coalesce(upper(s.enrollment_no)=usn_q,false) OR coalesce(strpos(lower(s.full_name),name_q)>0,false)
    ORDER BY ord LIMIT 10) m;
  RETURN jsonb_build_object('data',jsonb_build_object('matches',matches,
    'exact',EXISTS(SELECT 1 FROM jsonb_array_elements(matches) e WHERE (e->>'exact')::boolean)));
END $$;

CREATE FUNCTION placement.skill_students(q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE f jsonb; st text; page_no integer; size integer; n integer; rows_json jsonb;
BEGIN
  PERFORM placement.assert_officer();
  f:=placement.intel_filters(q,ARRAY['batch','department','status','page','limit']);
  st:=coalesce(f->>'status','complete');
  IF st NOT IN ('complete','incomplete','not_started') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.'; END IF;
  page_no:=coalesce((f->>'page')::integer,1);
  size:=coalesce((f->>'limit')::integer,25);
  IF size>100 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid pagination.'; END IF;
  WITH filtered AS MATERIALIZED(
    SELECT s.id,s.enrollment_no AS usn,s.full_name AS name,s.department_short_name AS department,s.source_batch AS batch,
      a.cgpa,erp.cgpa_category(a.cgpa) AS category,student.skill_status(s.id) AS skill_status,
      p.onboarding_completed_at AS completed_at,coalesce(p.consent_version,0)>=1 AS consented
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id LEFT JOIN student.skill_profiles p ON p.student_id=s.id
    WHERE (f->>'batch' IS NULL OR s.source_batch=f->>'batch')
      AND (f->>'department' IS NULL OR coalesce(s.department_short_name,'__missing__')=f->>'department')
      AND student.skill_status(s.id)=st)
  SELECT (SELECT count(*) FROM filtered),
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'usn',o.usn,'name',o.name,'department',o.department,'batch',o.batch,
      'cgpa',o.cgpa::text,'category',o.category,'skillStatus',o.skill_status,'completedAt',o.completed_at,
      'linkedPlatforms',coalesce((SELECT jsonb_agg(pa.platform ORDER BY array_position(ARRAY['github','leetcode','hackerrank','linkedin','huggingface','kaggle'],pa.platform))
        -- Student-provided platform data is shared only after consent, and never for hidden accounts.
        FROM student.platform_accounts pa WHERE o.consented AND pa.student_id=o.id AND pa.state='linked' AND pa.visible),'[]'::jsonb),
      'profileUrl','/placement/students/'||o.id::text) ORDER BY o.batch,o.usn COLLATE "C",o.id)
      FROM (SELECT * FROM filtered x ORDER BY x.batch,x.usn COLLATE "C",x.id LIMIT size OFFSET (page_no-1)*size) o),'[]'::jsonb)
  INTO n,rows_json;
  RETURN jsonb_build_object('data',jsonb_build_object('rows',rows_json,
    'pagination',jsonb_build_object('total',n,'page',page_no,'limit',size)));
END $$;

-- Same ownership pattern as public.dsu_placement_read: the RPCs run as dsu_placement
-- (officer RLS applies), and only the backend role may call them.
GRANT CREATE ON SCHEMA placement TO dsu_placement;
ALTER FUNCTION placement.ranked_students(jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.category_cards(jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.overview_charts(jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.student_core(uuid) OWNER TO dsu_placement;
ALTER FUNCTION placement.skill_profile(uuid,text) OWNER TO dsu_placement;
ALTER FUNCTION placement.lookup_students(jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.skill_students(jsonb) OWNER TO dsu_placement;
REVOKE CREATE ON SCHEMA placement FROM dsu_placement;
REVOKE ALL ON FUNCTION placement.ranked_students(jsonb),placement.category_cards(jsonb),placement.overview_charts(jsonb),
  placement.student_core(uuid),placement.skill_profile(uuid,text),placement.lookup_students(jsonb),placement.skill_students(jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION placement.ranked_students(jsonb),placement.category_cards(jsonb),placement.overview_charts(jsonb),
  placement.student_core(uuid),placement.skill_profile(uuid,text),placement.lookup_students(jsonb),placement.skill_students(jsonb)
  TO dsu_api;


-- Owner-scoped cleanup for disconnect and relink. Students cannot delete
-- worker-written rows under RLS; this function removes only the synced data
-- of an account that belongs to the calling student, so route code never
-- needs worker rights.
CREATE FUNCTION student.clear_platform_data(account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE owner uuid;
BEGIN
  SELECT a.student_id INTO owner FROM student.platform_accounts a WHERE a.id=account;
  IF owner IS NULL OR owner IS DISTINCT FROM erp.actor_student() THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='This connection is unavailable.';
  END IF;
  DELETE FROM student.platform_metrics WHERE account_id=account;
  DELETE FROM student.github_repositories WHERE account_id=account;
  DELETE FROM student.platform_snapshots WHERE account_id=account;
  UPDATE student.sync_jobs SET status='cancelled',leased_until=NULL,updated_at=now()
    WHERE account_id=account AND status IN ('pending','running');
  UPDATE student.platform_accounts SET last_synced_at=NULL WHERE id=account;
END $$;
REVOKE ALL ON FUNCTION student.clear_platform_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION student.clear_platform_data(uuid) TO dsu_api;

NOTIFY pgrst,'reload schema';
