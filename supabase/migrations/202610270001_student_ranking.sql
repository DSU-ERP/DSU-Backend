-- Students Ranking v1 (Placement Officer Portal). Additive and backward compatible:
-- a new `ranking` schema, one new column on student.github_repositories and the
-- move of linked LeetCode profiles from link-only to public-profile sync.
-- No existing table, policy or function is dropped or rewritten. CGPA and the
-- canonical student records are only read. See docs/student-ranking/database.md.

-- 1. Evidence ---------------------------------------------------------------------
-- Structural repository evidence (root file names, CI, tests, releases, commit
-- share) collected by the GitHub sync. Empty until the next sync.
ALTER TABLE student.github_repositories
  ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=8000);

-- LeetCode profiles are now read from LeetCode's public profile data by the sync
-- worker (never during page rendering). Existing linked profiles sync on the next
-- scheduled pass; student-submitted figures stay stored and labelled as before.
UPDATE student.platform_accounts SET auth_method='public_api',sync_status='pending',updated_at=now()
  WHERE platform='leetcode' AND state='linked' AND auth_method='link_only';

-- LeetCode name check: does the username, or the profile name LeetCode shows,
-- match the student's official name? A plausibility check shown to students and
-- officers as Verified or Unverified; not proof of ownership and not a score input.
ALTER TABLE student.platform_accounts
  ADD COLUMN name_match text CHECK(name_match IN ('verified','unverified')),
  ADD COLUMN name_match_source text CHECK(name_match_source IN ('username','profile_name'));

-- The sync worker needs only the official name of the account's student for
-- that check, so it gets exactly that and nothing else from erp.students.
CREATE FUNCTION student.sync_student_name(account uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT student.sync_worker() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Restricted to the sync worker.'; END IF;
  RETURN (SELECT s.full_name FROM student.platform_accounts a JOIN erp.students s ON s.id=a.student_id WHERE a.id=account);
END $$;
REVOKE ALL ON FUNCTION student.sync_student_name(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION student.sync_student_name(uuid) TO dsu_api;

-- 2. Schema ----------------------------------------------------------------------------
CREATE SCHEMA ranking;
REVOKE ALL ON SCHEMA ranking FROM PUBLIC;

-- Versioned scoring configuration. Exactly one model is current. Weights and
-- constants live here, never in page code.
CREATE TABLE ranking.models(
  version text PRIMARY KEY CHECK(version ~ '^[a-z0-9][a-z0-9.-]{2,79}$'),
  status text NOT NULL CHECK(status IN ('experimental','approved','retired')),
  current boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='object' AND config->>'version' IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CHECK(config->>'version'=version)
);
CREATE UNIQUE INDEX models_one_current ON ranking.models(current) WHERE current;

-- Competency taxonomy. source NULL means not yet assessable from v1 evidence.
CREATE TABLE ranking.topics(
  code text PRIMARY KEY CHECK(code ~ '^[a-z]+\.[a-z0-9-]{2,40}$'),
  family text NOT NULL CHECK(family IN ('dsa','software','core-cs','specialization')),
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 100),
  source text CHECK(source IN ('leetcode','github')),
  position integer NOT NULL UNIQUE
);

-- Current score per student and model. Numbers exist only for scored or stale
-- components; every other status carries a reason in `explanation`.
CREATE TABLE ranking.scores(
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  model_version text NOT NULL REFERENCES ranking.models(version),
  academic numeric(5,2) CHECK(academic BETWEEN 0 AND 100),
  dsa numeric(5,2) CHECK(dsa BETWEEN 0 AND 100),
  github numeric(5,2) CHECK(github BETWEEN 0 AND 100),
  developer numeric(5,2) CHECK(developer BETWEEN 0 AND 100),
  academic_status text NOT NULL CHECK(academic_status IN ('scored','missing','invalid')),
  dsa_status text NOT NULL CHECK(dsa_status IN ('scored','stale','not_linked','hidden','pending','unavailable','disputed')),
  github_status text NOT NULL CHECK(github_status IN ('scored','stale','not_linked','hidden','pending','unavailable')),
  developer_status text NOT NULL CHECK(developer_status IN ('scored','pending')),
  coverage numeric(3,2) NOT NULL CHECK(coverage BETWEEN 0 AND 1),
  evidence_state text NOT NULL CHECK(evidence_state IN ('complete','partial','pending')),
  explanation jsonb NOT NULL CHECK(jsonb_typeof(explanation)='object'),
  evidence_synced_at timestamptz,
  input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK(result_hash ~ '^[0-9a-f]{64}$'),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(student_id,model_version),
  CHECK((academic IS NOT NULL)=(academic_status='scored')),
  CHECK((dsa IS NOT NULL)=(dsa_status IN ('scored','stale'))),
  CHECK((github IS NOT NULL)=(github_status IN ('scored','stale'))),
  CHECK((developer IS NOT NULL)=(developer_status='scored'))
);
CREATE INDEX scores_dsa ON ranking.scores(model_version,dsa DESC) WHERE dsa IS NOT NULL;
CREATE INDEX scores_github ON ranking.scores(model_version,github DESC) WHERE github IS NOT NULL;
CREATE INDEX scores_developer ON ranking.scores(model_version,developer DESC) WHERE developer IS NOT NULL;

CREATE TABLE ranking.topic_scores(
  student_id uuid NOT NULL,
  model_version text NOT NULL,
  topic_code text NOT NULL REFERENCES ranking.topics(code),
  source text NOT NULL CHECK(source IN ('leetcode','github')),
  score numeric(5,2) NOT NULL CHECK(score BETWEEN 0 AND 100),
  stale boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  PRIMARY KEY(student_id,model_version,topic_code),
  FOREIGN KEY(student_id,model_version) REFERENCES ranking.scores(student_id,model_version) ON DELETE CASCADE
);
CREATE INDEX topic_scores_rank ON ranking.topic_scores(model_version,topic_code,score DESC);

-- Append-only record of every changed score (inputs hash and full result), so a
-- past ranking can be explained after the evidence moves on.
CREATE TABLE ranking.score_history(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  model_version text NOT NULL REFERENCES ranking.models(version),
  input_hash text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  calculated_at timestamptz NOT NULL
);
CREATE INDEX score_history_student ON ranking.score_history(student_id,calculated_at DESC);

-- Students waiting for recalculation (new evidence, nightly pass, model change).
CREATE TABLE ranking.queue(
  student_id uuid PRIMARY KEY REFERENCES erp.students(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK(reason IN ('sync','scheduled','model','manual','student')),
  queued_at timestamptz NOT NULL DEFAULT now()
);

-- Audit of calculation work: each processed batch and each full-pass request.
CREATE TABLE ranking.runs(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_version text NOT NULL REFERENCES ranking.models(version),
  kind text NOT NULL CHECK(kind IN ('batch','full_request')),
  students integer NOT NULL DEFAULT 0 CHECK(students>=0),
  changed integer NOT NULL DEFAULT 0 CHECK(changed>=0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX runs_recent ON ranking.runs(model_version,kind,started_at DESC);

-- 3. Seed: model v1 and taxonomy (mirrors src/modules/ranking/{model-v1.json,taxonomy.js}) --
INSERT INTO ranking.models(version,status,current,config,activated_at) VALUES(
  'developer-competency-v1-experimental','experimental',true,
  '{"version":"developer-competency-v1-experimental","status":"experimental","label":"Developer competency v1 (provisional)",
    "weights":{"academic":0.5,"dsa":0.3,"github":0.2},"freshnessDays":30,"academic":{"scale":10},
    "dsa":{"easyCap":150,"difficulty":{"easy":1,"medium":3,"hard":6},"volumeK":300,"advancedK":150,"mix":{"volume":0.6,"advanced":0.4}},
    "github":{"topWeights":[0.5,0.3,0.2],"topShare":0.95,"breadthThreshold":40,"breadthPerRepo":1,"breadthMax":5,"minObservedShare":0.7},
    "topics":{"dsaK":20,"dsaMinSolved":3},"eligibility":{"developer":"all_with_complete_fresh_evidence"},
    "duplicateLeetCodeClaims":"exclude"}'::jsonb,now());

INSERT INTO ranking.topics(code,family,label,source,position) VALUES
  ('dsa.arrays','dsa','Arrays','leetcode',1),
  ('dsa.strings','dsa','Strings','leetcode',2),
  ('dsa.hashing','dsa','Hashing','leetcode',3),
  ('dsa.linked-lists','dsa','Linked lists','leetcode',4),
  ('dsa.stacks','dsa','Stacks','leetcode',5),
  ('dsa.queues','dsa','Queues','leetcode',6),
  ('dsa.trees','dsa','Trees','leetcode',7),
  ('dsa.graphs','dsa','Graphs','leetcode',8),
  ('dsa.dynamic-programming','dsa','Dynamic programming','leetcode',9),
  ('dsa.greedy','dsa','Greedy algorithms','leetcode',10),
  ('dsa.binary-search','dsa','Binary search','leetcode',11),
  ('dsa.recursion','dsa','Recursion','leetcode',12),
  ('dsa.backtracking','dsa','Backtracking','leetcode',13),
  ('dsa.heaps','dsa','Heaps','leetcode',14),
  ('dsa.sorting','dsa','Sorting','leetcode',15),
  ('dsa.sliding-window','dsa','Sliding window','leetcode',16),
  ('dsa.two-pointers','dsa','Two pointers','leetcode',17),
  ('dsa.bit-manipulation','dsa','Bit manipulation','leetcode',18),
  ('project.web','software','Web development','github',19),
  ('project.backend','software','Backend development','github',20),
  ('project.fullstack','software','Full-stack development','github',21),
  ('project.python','software','Python development','github',22),
  ('project.java','software','Java development','github',23),
  ('project.cloud-devops','software','Cloud and DevOps','github',24),
  ('project.mobile','software','Mobile development','github',25),
  ('project.ml','specialization','Machine learning projects','github',26),
  ('project.data-science','specialization','Data science projects','github',27),
  ('project.cybersecurity','specialization','Cybersecurity projects','github',28),
  ('project.embedded','specialization','Embedded systems projects','github',29),
  ('project.robotics','specialization','Robotics projects','github',30),
  ('core.oop','software','Object-oriented programming',NULL,31),
  ('core.software-testing','software','Software testing',NULL,32),
  ('core.dbms','core-cs','Database management systems',NULL,33),
  ('core.os','core-cs','Operating systems',NULL,34),
  ('core.networks','core-cs','Computer networks',NULL,35),
  ('core.organization','core-cs','Computer organization',NULL,36),
  ('core.software-engineering','core-cs','Software engineering',NULL,37),
  ('spec.ai','specialization','Artificial intelligence',NULL,38);

-- 4. Worker functions (backend sync worker only: app.sync_worker='on') -------------
-- Inputs for the scoring engine. Reads only what scoring needs: no contacts,
-- credentials, submitted figures or profile text.
CREATE FUNCTION ranking.calculation_inputs(ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT student.sync_worker() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Ranking calculation is restricted to the sync worker.'; END IF;
  IF coalesce(cardinality(ids),0)>1000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='At most 1000 students per batch.'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id',s.id,
      'cgpa',a.cgpa::text,
      'consented',coalesce(p.consent_version,0)>=1,
      'visibility',coalesce(p.visibility,'{}'::jsonb),
      'leetcode',(SELECT jsonb_build_object('state',l.state,'visible',l.visible,'handle',l.handle,'syncStatus',l.sync_status,
          'nameMatch',l.name_match,'nameMatchSource',l.name_match_source,
          'syncError',l.sync_error,'lastSyncedAt',l.last_synced_at,
          'disputed',EXISTS(SELECT 1 FROM student.platform_accounts o WHERE o.platform='leetcode' AND o.state='linked'
            AND o.student_id<>l.student_id AND lower(o.handle)=lower(l.handle)),
          'metrics',coalesce((SELECT jsonb_object_agg(m.metric,m.value) FROM student.platform_metrics m
            WHERE m.account_id=l.id AND m.verification='platform_verified'
              AND (m.metric LIKE 'problems.%' OR m.metric LIKE 'contest.%' OR m.metric='topics.solved')),'{}'::jsonb))
        FROM student.platform_accounts l WHERE l.student_id=s.id AND l.platform='leetcode'),
      'github',(SELECT jsonb_build_object('state',g.state,'visible',g.visible,'handle',g.handle,'syncStatus',g.sync_status,
          'syncError',g.sync_error,'lastSyncedAt',g.last_synced_at,
          'repos',coalesce((SELECT jsonb_agg(jsonb_build_object('repoId',r.repo_id,'name',r.name,'fullName',r.full_name,'url',r.url,
              'description',r.description,'primaryLanguage',r.primary_language,'languages',r.languages,'topics',r.topics,
              'isFork',r.is_fork,'isArchived',r.is_archived,'hasReadme',r.has_readme,'readmeBytes',r.readme_bytes,
              'license',r.license,'homepage',r.homepage,'pushedAt',r.pushed_at,'ownerLogin',r.owner_login,
              'additions52w',r.additions_52w,'evidence',r.evidence) ORDER BY r.repo_id)
            FROM student.github_repositories r WHERE r.account_id=g.id),'[]'::jsonb))
        FROM student.platform_accounts g WHERE g.student_id=s.id AND g.platform='github')
    ) ORDER BY s.id)
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
      LEFT JOIN student.skill_profiles p ON p.student_id=s.id
    WHERE s.id=ANY(ids)),'[]'::jsonb);
END $$;

-- The worker queues after new evidence. A student may queue only their own
-- record ('student'), after changing what they share, so hidden data leaves
-- the officer view on the next worker tick rather than the nightly pass.
CREATE FUNCTION ranking.request_recalculation(target uuid,why text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT (student.sync_worker() OR coalesce(why='student' AND target=erp.actor_student(),false)) THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE='Ranking calculation is restricted to the sync worker.';
  END IF;
  INSERT INTO ranking.queue(student_id,reason) VALUES(target,why) ON CONFLICT(student_id) DO NOTHING;
END $$;

-- Queues every student when the current model has had no full pass within
-- `min_age` (nightly refresh and model changes). Returns the number queued.
CREATE FUNCTION ranking.request_full_recalculation(min_age interval) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE mv text; n integer;
BEGIN
  IF NOT student.sync_worker() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Ranking calculation is restricted to the sync worker.'; END IF;
  SELECT version INTO mv FROM ranking.models WHERE current;
  IF mv IS NULL THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ranking.full_request'));
  IF EXISTS(SELECT 1 FROM ranking.runs r WHERE r.model_version=mv AND r.kind='full_request' AND r.started_at>now()-min_age) THEN RETURN 0; END IF;
  INSERT INTO ranking.queue(student_id,reason)
    SELECT s.id,CASE WHEN EXISTS(SELECT 1 FROM ranking.runs r WHERE r.model_version=mv AND r.kind='full_request') THEN 'scheduled' ELSE 'model' END
    FROM erp.students s ON CONFLICT(student_id) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  INSERT INTO ranking.runs(model_version,kind,students,finished_at) VALUES(mv,'full_request',n,now());
  RETURN n;
END $$;

-- 5. Access ----------------------------------------------------------------------------
ALTER TABLE ranking.models ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking.scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking.topic_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking.score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking.queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking.runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA ranking FROM PUBLIC,anon,authenticated;

-- Backend worker: writes scores. Students never read or write ranking data in v1.
GRANT USAGE ON SCHEMA ranking TO dsu_api;
GRANT SELECT ON ranking.models,ranking.topics TO dsu_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON ranking.scores,ranking.topic_scores,ranking.queue TO dsu_api;
GRANT SELECT,INSERT,DELETE ON ranking.score_history TO dsu_api;
GRANT SELECT,INSERT,UPDATE ON ranking.runs TO dsu_api;
CREATE POLICY worker_read ON ranking.models FOR SELECT TO dsu_api USING(student.sync_worker());
CREATE POLICY worker_read ON ranking.topics FOR SELECT TO dsu_api USING(student.sync_worker());
CREATE POLICY worker_all ON ranking.scores TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());
CREATE POLICY worker_all ON ranking.topic_scores TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());
CREATE POLICY worker_all ON ranking.score_history TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());
CREATE POLICY worker_all ON ranking.queue TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());
CREATE POLICY worker_all ON ranking.runs TO dsu_api USING(student.sync_worker()) WITH CHECK(student.sync_worker());

-- Placement officers: read only, through the guarded RPCs below.
GRANT USAGE ON SCHEMA ranking TO dsu_placement;
GRANT SELECT ON ranking.models,ranking.topics,ranking.scores,ranking.topic_scores,ranking.runs TO dsu_placement;
CREATE POLICY officer_read ON ranking.models FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON ranking.topics FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON ranking.scores FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON ranking.topic_scores FOR SELECT TO dsu_placement USING(placement.authorized());
CREATE POLICY officer_read ON ranking.runs FOR SELECT TO dsu_placement USING(placement.authorized());

REVOKE ALL ON FUNCTION ranking.calculation_inputs(uuid[]),ranking.request_recalculation(uuid,text),
  ranking.request_full_recalculation(interval) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ranking.calculation_inputs(uuid[]),ranking.request_recalculation(uuid,text),
  ranking.request_full_recalculation(interval) TO dsu_api;

-- 6. Officer RPCs (SECURITY DEFINER, owned by dsu_placement, officer-guarded) -------
-- Shared filter validation for the ranking reads.
CREATE FUNCTION placement.ranking_filters(q jsonb,allowed text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE f jsonb;
BEGIN
  f:=placement.intel_filters(q,allowed);
  IF coalesce(f->>'kind','academic') NOT IN ('academic','dsa','github','developer','topic')
    OR coalesce(f->>'evidence','complete') NOT IN ('complete','partial','pending')
    OR coalesce(f->>'show','ranked') NOT IN ('ranked','all')
    OR coalesce(f->>'updated','7') NOT IN ('7','30','older')
    OR length(coalesce(f->>'semester',''))>20
    OR (f ? 'topic' AND NOT EXISTS(SELECT 1 FROM ranking.topics t WHERE t.code=f->>'topic' AND t.source IS NOT NULL))
    OR (f->>'kind'='topic' AND NOT f ? 'topic') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.';
  END IF;
  RETURN f;
END $$;

CREATE FUNCTION placement.ranking_overview(q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE f jsonb; m record; counts jsonb; options jsonb; topics jsonb;
BEGIN
  PERFORM placement.assert_officer();
  f:=placement.ranking_filters(q,ARRAY['batch','department','semester']);
  SELECT version,status,config,activated_at INTO m FROM ranking.models WHERE current;
  WITH cohort AS MATERIALIZED(
    SELECT s.id,a.cgpa,sc.dsa_status,sc.github_status,sc.developer_status,sc.evidence_state,sc.calculated_at,
      EXISTS(SELECT 1 FROM student.platform_accounts x WHERE x.student_id=s.id AND x.platform='github' AND x.state='linked') AS github_linked,
      EXISTS(SELECT 1 FROM student.platform_accounts x WHERE x.student_id=s.id AND x.platform='leetcode' AND x.state='linked') AS leetcode_linked
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
      LEFT JOIN ranking.scores sc ON sc.student_id=s.id AND sc.model_version=m.version
    WHERE (f->>'batch' IS NULL OR s.source_batch=f->>'batch')
      AND (f->>'department' IS NULL OR coalesce(s.department_short_name,'__missing__')=f->>'department')
      AND (f->>'semester' IS NULL OR s.current_semester=f->>'semester'))
  SELECT jsonb_build_object(
    'students',count(*),
    'validCgpa',count(*) FILTER(WHERE c.cgpa IS NOT NULL),
    'githubLinked',count(*) FILTER(WHERE c.github_linked),
    'leetcodeLinked',count(*) FILTER(WHERE c.leetcode_linked),
    'dsaScored',count(*) FILTER(WHERE c.dsa_status IN ('scored','stale')),
    'githubScored',count(*) FILTER(WHERE c.github_status IN ('scored','stale')),
    'developerEligible',count(*) FILTER(WHERE c.developer_status='scored'),
    'awaitingEvidence',count(*) FILTER(WHERE c.dsa_status IN ('pending','unavailable') OR c.github_status IN ('pending','unavailable')),
    'notCalculated',count(*) FILTER(WHERE c.calculated_at IS NULL),
    'lastCalculatedAt',max(c.calculated_at),
    'oldestCalculatedAt',min(c.calculated_at))
  INTO counts FROM cohort c;
  SELECT jsonb_build_object(
    'batches',coalesce((SELECT jsonb_agg(b ORDER BY b DESC) FROM (SELECT DISTINCT source_batch b FROM erp.students) x),'[]'::jsonb),
    'departments',coalesce((SELECT jsonb_agg(jsonb_build_object('code',d,'name',n) ORDER BY d) FROM
      (SELECT coalesce(department_short_name,'__missing__') d,max(department_name) n FROM erp.students GROUP BY 1) x),'[]'::jsonb),
    'semesters',coalesce((SELECT jsonb_agg(sm ORDER BY length(sm),sm) FROM
      (SELECT DISTINCT current_semester sm FROM erp.students WHERE current_semester IS NOT NULL) x),'[]'::jsonb))
  INTO options;
  SELECT coalesce(jsonb_agg(jsonb_build_object('code',t.code,'family',t.family,'label',t.label,'source',t.source,
      'students',(SELECT count(*) FROM ranking.topic_scores ts JOIN erp.students s ON s.id=ts.student_id
        WHERE ts.model_version=m.version AND ts.topic_code=t.code
          AND (f->>'batch' IS NULL OR s.source_batch=f->>'batch')
          AND (f->>'department' IS NULL OR coalesce(s.department_short_name,'__missing__')=f->>'department')
          AND (f->>'semester' IS NULL OR s.current_semester=f->>'semester'))) ORDER BY t.position),'[]'::jsonb)
  INTO topics FROM ranking.topics t;
  RETURN jsonb_build_object('data',jsonb_build_object('counts',counts,'options',options,'topics',topics,
    'model',CASE WHEN m.version IS NULL THEN NULL ELSE jsonb_build_object('version',m.version,'status',m.status,
      'label',m.config->>'label','weights',m.config->'weights','freshnessDays',m.config->'freshnessDays','activatedAt',m.activated_at) END,
    'filters',f));
END $$;

-- One ranking view. Cohort filters (batch, department, semester) define who is
-- ranked; search, evidence and freshness filters only hide rows, so ranks hold
-- across pages and searches. Dense rank; ties display by USN, then id.
CREATE FUNCTION placement.ranking_list(q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE f jsonb; mv text; sel_kind text; sel_topic text; page_no integer; size integer; n integer; ranked_n integer; rows_json jsonb;
BEGIN
  PERFORM placement.assert_officer();
  f:=placement.ranking_filters(q,ARRAY['kind','topic','batch','department','semester','evidence','updated','show','search','page','limit']);
  SELECT version INTO mv FROM ranking.models WHERE current;
  sel_kind:=coalesce(f->>'kind','academic');
  sel_topic:=CASE WHEN sel_kind='topic' THEN f->>'topic' END;
  page_no:=coalesce((f->>'page')::integer,1);
  size:=coalesce((f->>'limit')::integer,25);
  IF size>100 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid pagination.'; END IF;

  WITH cohort AS MATERIALIZED(
    SELECT s.id,s.enrollment_no AS usn,s.full_name AS name,s.department_short_name AS department,s.department_name,
      s.source_batch AS batch,s.current_semester AS semester,a.cgpa,
      sc.academic,sc.dsa,sc.github,sc.developer,sc.academic_status,sc.dsa_status,sc.github_status,sc.developer_status,
      sc.evidence_state,sc.calculated_at,sc.evidence_synced_at,sc.coverage,
      sc.explanation->'dsa'->'explanation'->>'contestRating' AS contest_rating,
      sc.explanation->'dsa'->'explanation'->>'nameMatch' AS leetcode_name_match,
      ts.score AS topic_score,ts.stale AS topic_stale,ts.evidence AS topic_evidence,
      CASE sel_kind WHEN 'academic' THEN a.cgpa WHEN 'dsa' THEN sc.dsa WHEN 'github' THEN sc.github
        WHEN 'developer' THEN sc.developer ELSE ts.score END AS value
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
      LEFT JOIN ranking.scores sc ON sc.student_id=s.id AND sc.model_version=mv
      LEFT JOIN ranking.topic_scores ts ON ts.student_id=s.id AND ts.model_version=mv AND ts.topic_code=sel_topic
    WHERE (f->>'batch' IS NULL OR s.source_batch=f->>'batch')
      AND (f->>'department' IS NULL OR coalesce(s.department_short_name,'__missing__')=f->>'department')
      AND (f->>'semester' IS NULL OR s.current_semester=f->>'semester')),
  ranked AS MATERIALIZED(
    SELECT c.*,CASE WHEN c.value IS NOT NULL THEN dense_rank() OVER(PARTITION BY c.value IS NULL ORDER BY c.value DESC) END AS rnk
    FROM cohort c),
  shown AS MATERIALIZED(
    SELECT r.* FROM ranked r
    WHERE (coalesce(f->>'show','ranked')='all' OR r.rnk IS NOT NULL)
      AND (f->>'search' IS NULL OR strpos(lower(r.name),lower(f->>'search'))>0 OR strpos(lower(r.usn),lower(f->>'search'))>0)
      AND (f->>'evidence' IS NULL OR coalesce(r.evidence_state,'pending')=f->>'evidence')
      AND (f->>'updated' IS NULL
        OR (f->>'updated'='older' AND (r.evidence_synced_at IS NULL OR r.evidence_synced_at<now()-interval '30 days'))
        OR (f->>'updated'='7' AND r.evidence_synced_at>=now()-interval '7 days')
        OR (f->>'updated'='30' AND r.evidence_synced_at>=now()-interval '30 days')))
  SELECT (SELECT count(*) FROM shown),(SELECT count(*) FROM ranked WHERE rnk IS NOT NULL),
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'usn',o.usn,'name',o.name,'department',o.department,
      'departmentName',o.department_name,'batch',o.batch,'semester',o.semester,'cgpa',o.cgpa::text,'rank',o.rnk,
      'value',o.value::text,
      'scores',jsonb_build_object('academic',o.academic,'dsa',o.dsa,'github',o.github,'developer',o.developer),
      'statuses',jsonb_build_object('academic',coalesce(o.academic_status,CASE WHEN o.cgpa IS NULL THEN 'missing' ELSE 'scored' END),
        'dsa',coalesce(o.dsa_status,'not_calculated'),'github',coalesce(o.github_status,'not_calculated'),
        'developer',coalesce(o.developer_status,'not_calculated')),
      'contestRating',o.contest_rating,'leetcodeNameMatch',o.leetcode_name_match,
      'topic',CASE WHEN sel_topic IS NULL THEN NULL ELSE jsonb_build_object('code',sel_topic,'score',o.topic_score,
        'stale',o.topic_stale,'evidence',o.topic_evidence) END,
      'evidenceState',coalesce(o.evidence_state,'pending'),'coverage',o.coverage,
      'calculatedAt',o.calculated_at,'evidenceSyncedAt',o.evidence_synced_at) ORDER BY o.ord)
      FROM (SELECT x.*,row_number() OVER(ORDER BY x.rnk NULLS LAST,x.usn COLLATE "C",x.id) AS ord FROM shown x
        ORDER BY x.rnk NULLS LAST,x.usn COLLATE "C",x.id LIMIT size OFFSET (page_no-1)*size) o),'[]'::jsonb)
  INTO n,ranked_n,rows_json;

  RETURN jsonb_build_object('data',jsonb_build_object('rows',rows_json,
    'pagination',jsonb_build_object('total',n,'page',page_no,'limit',size),
    'scope',jsonb_build_object('kind',sel_kind,'topic',sel_topic,'modelVersion',mv,'ranked',ranked_n,
      'batch',f->>'batch','department',f->>'department','semester',f->>'semester')));
END $$;

-- One student's scores, explanation, topic evidence and positions.
CREATE FUNCTION placement.ranking_student(target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE mv text; me record; sc record; positions jsonb; topics jsonb;
BEGIN
  PERFORM placement.assert_officer();
  SELECT version INTO mv FROM ranking.models WHERE current;
  SELECT s.id,s.enrollment_no AS usn,s.full_name AS name,s.department_short_name AS department,s.department_name,
    s.source_batch AS batch,s.current_semester AS semester,a.cgpa
    INTO me FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id WHERE s.id=target;
  IF me.id IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Student not found.'; END IF;
  SELECT * INTO sc FROM ranking.scores x WHERE x.student_id=target AND x.model_version=mv;
  WITH base AS MATERIALIZED(
    SELECT s.id,s.source_batch AS batch,coalesce(s.department_short_name,'__missing__') AS department,a.cgpa,x.dsa,x.github,x.developer
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
      LEFT JOIN ranking.scores x ON x.student_id=s.id AND x.model_version=mv),
  r AS(
    SELECT b.id,
      CASE WHEN b.cgpa IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.cgpa IS NULL ORDER BY b.cgpa DESC) END AS academic_university,
      CASE WHEN b.cgpa IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.cgpa IS NULL,b.batch ORDER BY b.cgpa DESC) END AS academic_batch,
      CASE WHEN b.cgpa IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.cgpa IS NULL,b.batch,b.department ORDER BY b.cgpa DESC) END AS academic_department,
      CASE WHEN b.dsa IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.dsa IS NULL ORDER BY b.dsa DESC) END AS dsa_university,
      CASE WHEN b.dsa IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.dsa IS NULL,b.batch ORDER BY b.dsa DESC) END AS dsa_batch,
      CASE WHEN b.github IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.github IS NULL ORDER BY b.github DESC) END AS github_university,
      CASE WHEN b.github IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.github IS NULL,b.batch ORDER BY b.github DESC) END AS github_batch,
      CASE WHEN b.developer IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.developer IS NULL ORDER BY b.developer DESC) END AS developer_university,
      CASE WHEN b.developer IS NOT NULL THEN dense_rank() OVER(PARTITION BY b.developer IS NULL,b.batch ORDER BY b.developer DESC) END AS developer_batch,
      count(b.cgpa) OVER() AS academic_university_n,count(b.cgpa) OVER(PARTITION BY b.batch) AS academic_batch_n,
      count(b.cgpa) OVER(PARTITION BY b.batch,b.department) AS academic_department_n,
      count(b.dsa) OVER() AS dsa_university_n,count(b.dsa) OVER(PARTITION BY b.batch) AS dsa_batch_n,
      count(b.github) OVER() AS github_university_n,count(b.github) OVER(PARTITION BY b.batch) AS github_batch_n,
      count(b.developer) OVER() AS developer_university_n,count(b.developer) OVER(PARTITION BY b.batch) AS developer_batch_n
    FROM base b)
  SELECT jsonb_build_object(
    'academic',jsonb_build_object('university',jsonb_build_object('rank',r.academic_university,'of',r.academic_university_n),
      'batch',jsonb_build_object('rank',r.academic_batch,'of',r.academic_batch_n),
      'department',jsonb_build_object('rank',r.academic_department,'of',r.academic_department_n)),
    'dsa',jsonb_build_object('university',jsonb_build_object('rank',r.dsa_university,'of',r.dsa_university_n),
      'batch',jsonb_build_object('rank',r.dsa_batch,'of',r.dsa_batch_n)),
    'github',jsonb_build_object('university',jsonb_build_object('rank',r.github_university,'of',r.github_university_n),
      'batch',jsonb_build_object('rank',r.github_batch,'of',r.github_batch_n)),
    'developer',jsonb_build_object('university',jsonb_build_object('rank',r.developer_university,'of',r.developer_university_n),
      'batch',jsonb_build_object('rank',r.developer_batch,'of',r.developer_batch_n)))
  INTO positions FROM r WHERE r.id=target;
  SELECT coalesce(jsonb_agg(jsonb_build_object('code',t.code,'family',t.family,'label',t.label,'source',t.source,
      'score',ts.score,'stale',ts.stale,'evidence',ts.evidence) ORDER BY t.position),'[]'::jsonb)
    INTO topics FROM ranking.topics t
    LEFT JOIN ranking.topic_scores ts ON ts.topic_code=t.code AND ts.student_id=target AND ts.model_version=mv;
  RETURN jsonb_build_object('data',jsonb_build_object(
    'student',jsonb_build_object('id',me.id,'usn',me.usn,'name',me.name,'department',me.department,'departmentName',me.department_name,
      'batch',me.batch,'semester',me.semester,'cgpa',me.cgpa::text),
    'modelVersion',mv,
    'score',CASE WHEN sc.student_id IS NULL THEN NULL ELSE jsonb_build_object(
      'academic',sc.academic,'dsa',sc.dsa,'github',sc.github,'developer',sc.developer,
      'statuses',jsonb_build_object('academic',sc.academic_status,'dsa',sc.dsa_status,'github',sc.github_status,'developer',sc.developer_status),
      'coverage',sc.coverage,'evidenceState',sc.evidence_state,'explanation',sc.explanation,
      'evidenceSyncedAt',sc.evidence_synced_at,'calculatedAt',sc.calculated_at) END,
    'positions',positions,'topics',topics));
END $$;

GRANT CREATE ON SCHEMA placement TO dsu_placement;
ALTER FUNCTION placement.ranking_overview(jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.ranking_list(jsonb) OWNER TO dsu_placement;
ALTER FUNCTION placement.ranking_student(uuid) OWNER TO dsu_placement;
REVOKE CREATE ON SCHEMA placement FROM dsu_placement;
REVOKE ALL ON FUNCTION placement.ranking_filters(jsonb,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION placement.ranking_filters(jsonb,text[]) TO dsu_placement;
REVOKE ALL ON FUNCTION placement.ranking_overview(jsonb),placement.ranking_list(jsonb),placement.ranking_student(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION placement.ranking_overview(jsonb),placement.ranking_list(jsonb),placement.ranking_student(uuid) TO dsu_api;
