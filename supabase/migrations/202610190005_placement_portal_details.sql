-- Fuller recruiting records: what a company hires for, and per-drive hiring
-- targets, so officers can track openings against selections and offers.
ALTER TABLE placement.companies
  ADD COLUMN about text CHECK (length(about) <= 4000),
  ADD COLUMN headquarters text CHECK (length(headquarters) <= 200),
  ADD COLUMN hiring_roles text CHECK (length(hiring_roles) <= 1000),
  ADD COLUMN job_categories text[] NOT NULL DEFAULT '{}' CHECK (cardinality(job_categories) <= 20);
ALTER TABLE placement.drives
  ADD COLUMN job_category text CHECK (length(job_category) <= 100),
  ADD COLUMN employment_type text CHECK (employment_type IS NULL OR employment_type IN ('full-time','internship','internship-ppo','contract')),
  ADD COLUMN openings integer CHECK (openings IS NULL OR openings BETWEEN 1 AND 100000);

CREATE FUNCTION placement.text_list(value jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT CASE WHEN jsonb_typeof(value)='array' THEN
    ARRAY(SELECT DISTINCT left(btrim(v),100) FROM jsonb_array_elements_text(value) v WHERE btrim(v)<>'' ORDER BY 1)
  WHEN jsonb_typeof(value)='string' AND btrim(value#>>'{}')<>'' THEN ARRAY[left(btrim(value#>>'{}'),100)]
  ELSE '{}'::text[] END
$$;
GRANT EXECUTE ON FUNCTION placement.text_list(jsonb) TO dsu_placement;

DO $migration$
DECLARE definition text; pairs text[][]; i integer;
  occurrences integer;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_mutate(text,jsonb,uuid)'::regprocedure);
  pairs := ARRAY[
    -- company.save update / insert
    ARRAY['active=coalesce((p->>''active'')::boolean,true),revision=revision+1,updated_at=now() WHERE id=target RETURNING to_jsonb(placement.companies.*) INTO result;',
          'about=CASE WHEN p ? ''about'' THEN nullif(btrim(p->>''about''),'''') ELSE company.about END,'
       || 'headquarters=CASE WHEN p ? ''headquarters'' THEN nullif(btrim(p->>''headquarters''),'''') ELSE company.headquarters END,'
       || 'hiring_roles=CASE WHEN p ? ''hiring_roles'' THEN nullif(btrim(p->>''hiring_roles''),'''') ELSE company.hiring_roles END,'
       || 'job_categories=CASE WHEN p ? ''job_categories'' THEN placement.text_list(p->''job_categories'') ELSE company.job_categories END,'
       || 'active=coalesce((p->>''active'')::boolean,true),revision=revision+1,updated_at=now() WHERE id=target RETURNING to_jsonb(placement.companies.*) INTO result;'],
    ARRAY['INSERT INTO placement.companies(name,short_name,industry,website,hr_name,hr_email,hr_phone,active)',
          'INSERT INTO placement.companies(about,headquarters,hiring_roles,job_categories,name,short_name,industry,website,hr_name,hr_email,hr_phone,active)'],
    ARRAY['VALUES(btrim(p->>''name''),nullif(btrim(p->>''short_name''),''''),',
          'VALUES(nullif(btrim(p->>''about''),''''),nullif(btrim(p->>''headquarters''),''''),nullif(btrim(p->>''hiring_roles''),''''),placement.text_list(p->''job_categories''),btrim(p->>''name''),nullif(btrim(p->>''short_name''),''''),'],
    -- drive.save validation / update / insert
    ARRAY['WHEN ''drive.save'' THEN',
          'WHEN ''drive.save'' THEN
   IF nullif(p->>''openings'','''') IS NOT NULL AND (p->>''openings'') !~ ''^[1-9][0-9]{0,4}$'' THEN
     RAISE SQLSTATE ''PT400'' USING MESSAGE=''Openings must be a whole number from 1 to 99999.'';
   END IF;
   IF nullif(p->>''employment_type'','''') IS NOT NULL AND p->>''employment_type'' NOT IN (''full-time'',''internship'',''internship-ppo'',''contract'') THEN
     RAISE SQLSTATE ''PT400'' USING MESSAGE=''Choose a valid employment type.'';
   END IF;'],
    ARRAY['UPDATE placement.drives SET min_attendance=',
          'UPDATE placement.drives SET job_category=CASE WHEN p ? ''job_category'' THEN nullif(left(btrim(p->>''job_category''),100),'''') ELSE drive.job_category END,'
       || 'employment_type=CASE WHEN p ? ''employment_type'' THEN nullif(p->>''employment_type'','''') ELSE drive.employment_type END,'
       || 'openings=CASE WHEN p ? ''openings'' THEN nullif(p->>''openings'','''')::integer ELSE drive.openings END,min_attendance='],
    ARRAY['INSERT INTO placement.drives(min_attendance,',
          'INSERT INTO placement.drives(job_category,employment_type,openings,min_attendance,'],
    ARRAY['VALUES(nullif(p->>''min_attendance'','''')::numeric,',
          'VALUES(nullif(left(btrim(p->>''job_category''),100),''''),nullif(p->>''employment_type'',''''),nullif(p->>''openings'','''')::integer,nullif(p->>''min_attendance'','''')::numeric,']];
  FOR i IN 1..array_length(pairs,1) LOOP
    occurrences := (length(definition) - length(replace(definition, pairs[i][1], ''))) / length(pairs[i][1]);
    IF occurrences <> 1 THEN RAISE EXCEPTION 'Expected one mutate anchor (% found): %', occurrences, left(pairs[i][1],80); END IF;
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  END LOOP;
  EXECUTE definition;
END
$migration$;

-- Reads: company hiring totals and drive hiring progress.
DO $migration$
DECLARE definition text; pairs text[][]; i integer; occurrences integer;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_read(text,jsonb)'::regprocedure);
  pairs := ARRAY[
    ARRAY['(SELECT count(*) FROM placement.offers o JOIN placement.registrations r ON r.id=o.registration_id JOIN placement.drives d ON d.id=r.drive_id WHERE d.company_id=c.id) offers',
          '(SELECT count(*) FROM placement.offers o JOIN placement.registrations r ON r.id=o.registration_id JOIN placement.drives d ON d.id=r.drive_id WHERE d.company_id=c.id) offers,'
       || '(SELECT count(DISTINCT r.student_id) FROM placement.registrations r JOIN placement.drives d ON d.id=r.drive_id WHERE d.company_id=c.id AND r.status IN (''selected'',''placed'')) selected,'
       || '(SELECT coalesce(sum(d.openings),0) FROM placement.drives d WHERE d.company_id=c.id) openings'],
    ARRAY['''counts'',jsonb_build_object(''notified'',',
          '''counts'',jsonb_build_object(''openings'',selected.openings,'
       || '''placed'',(SELECT count(*) FROM placement.registrations WHERE drive_id=target AND status=''placed''),'
       || '''active_offers'',(SELECT count(*) FROM placement.offers o JOIN placement.registrations r ON r.id=o.registration_id WHERE r.drive_id=target AND o.status IN (''offered'',''accepted'')),'
       || '''rounds_conducted'',(SELECT count(DISTINCT rr.round_number) FROM placement.round_results rr JOIN placement.registrations r ON r.id=rr.registration_id WHERE r.drive_id=target),'
       || '''notified'',']];
  FOR i IN 1..array_length(pairs,1) LOOP
    occurrences := (length(definition) - length(replace(definition, pairs[i][1], ''))) / length(pairs[i][1]);
    IF occurrences <> 1 THEN RAISE EXCEPTION 'Expected one read anchor (% found): %', occurrences, left(pairs[i][1],80); END IF;
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  END LOOP;
  EXECUTE definition;
END
$migration$;

-- A student's own recruitment track record, independent of drive visibility.
CREATE FUNCTION student.placement_record() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  WITH me AS (SELECT erp.actor_student() AS id),
  regs AS (
    SELECT r.id, r.status, r.current_round, r.created_at, r.updated_at, d.id AS drive_id, d.title, d.rounds,
      d.package_lpa, d.job_category, d.employment_type, d.drive_date, c.name AS company,
      coalesce((SELECT jsonb_agg(jsonb_build_object('round', rr.round_number, 'name', rr.round_name, 'result', rr.result,
        'recorded_at', rr.recorded_at) ORDER BY rr.round_number) FROM placement.round_results rr WHERE rr.registration_id = r.id), '[]') AS results
    FROM placement.registrations r JOIN placement.drives d ON d.id = r.drive_id JOIN placement.companies c ON c.id = d.company_id
    WHERE r.student_id = (SELECT id FROM me)
  ), offers AS (
    SELECT o.id, o.package_lpa, o.status, o.created_at, placement.package_category(o.package_lpa) AS category,
      d.title, c.name AS company, d.employment_type
    FROM placement.offers o JOIN placement.registrations r ON r.id = o.registration_id
    JOIN placement.drives d ON d.id = r.drive_id JOIN placement.companies c ON c.id = d.company_id
    WHERE r.student_id = (SELECT id FROM me)
  )
  SELECT jsonb_build_object(
    'registrations', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM regs x), '[]'),
    'offers', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM offers x), '[]'))
  WHERE (SELECT id FROM me) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION student.placement_record() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION student.placement_record() TO dsu_api;
NOTIFY pgrst,'reload schema';
