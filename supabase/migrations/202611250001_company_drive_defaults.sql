-- A company's default drive details: the role it recruits for, filled from a
-- recruiter PDF or by the officer in the company editor. Creating a drive for
-- the company starts from these; dates, batch and status stay per drive.
ALTER TABLE placement.companies
  ADD COLUMN drive_defaults jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(drive_defaults) = 'object' AND octet_length(drive_defaults::text) <= 32768);

-- Keeps only known drive fields with valid values. Accepts an object, or the
-- JSON text the officer form sends. Bad values are rejected, never guessed.
CREATE FUNCTION placement.company_drive_defaults(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE
  v jsonb := value;
  result jsonb := '{}'::jsonb;
  spec record;
  raw text;
  n numeric;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN '{}'::jsonb; END IF;
  IF jsonb_typeof(v) = 'string' THEN
    IF btrim(v #>> '{}') = '' THEN RETURN '{}'::jsonb; END IF;
    BEGIN
      v := (v #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = 'Default drive details are not valid.';
    END;
  END IF;
  IF jsonb_typeof(v) <> 'object' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Default drive details are not valid.';
  END IF;

  FOR spec IN SELECT * FROM (VALUES
    ('title', 200), ('job_category', 100), ('location', 200),
    ('skills', 2000), ('required_documents', 2000), ('description', 12000)
  ) AS t(key, size) LOOP
    IF jsonb_typeof(v -> spec.key) = 'string' AND btrim(v ->> spec.key) <> '' THEN
      result := result || jsonb_build_object(spec.key, left(btrim(v ->> spec.key), spec.size));
    END IF;
  END LOOP;

  IF nullif(v ->> 'employment_type', '') IS NOT NULL THEN
    IF v ->> 'employment_type' NOT IN ('full-time','internship','internship-ppo','contract') THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = 'Choose a valid default employment type.';
    END IF;
    result := result || jsonb_build_object('employment_type', v ->> 'employment_type');
  END IF;

  FOR spec IN SELECT * FROM (VALUES
    ('package_lpa', 'Default package', 0::numeric, 10000::numeric, false),
    ('min_cgpa', 'Default minimum CGPA', 0, 10, false),
    ('max_backlogs', 'Default maximum backlogs', 0, 100, true),
    ('min_attendance', 'Default minimum attendance', 0, 100, false),
    ('openings', 'Default openings', 1, 99999, true)
  ) AS t(key, label, low, high, whole) LOOP
    raw := btrim(coalesce(v ->> spec.key, ''));
    CONTINUE WHEN raw = '';
    IF raw !~ '^[0-9]+(\.[0-9]+)?$' THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = spec.label || ' must be a number.';
    END IF;
    n := raw::numeric;
    IF n < spec.low OR n > spec.high OR (spec.whole AND n <> trunc(n)) THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = spec.label || ' is out of range.';
    END IF;
    result := result || jsonb_build_object(spec.key, n);
  END LOOP;

  -- Branches: distinct, unordered. Rounds: kept in the order given.
  IF jsonb_typeof(v -> 'branches') = 'array' THEN
    result := result || jsonb_build_object('branches', to_jsonb(ARRAY(
      SELECT DISTINCT left(btrim(b), 100) FROM jsonb_array_elements_text(v -> 'branches') b
      WHERE btrim(b) <> '' ORDER BY 1 LIMIT 100)));
  END IF;
  IF jsonb_typeof(v -> 'rounds') = 'array' THEN
    result := result || jsonb_build_object('rounds', to_jsonb(ARRAY(
      SELECT left(btrim(r), 100) FROM jsonb_array_elements_text(v -> 'rounds') WITH ORDINALITY AS x(r, i)
      WHERE btrim(r) <> '' ORDER BY i LIMIT 20)));
  END IF;
  RETURN result;
END
$$;
GRANT EXECUTE ON FUNCTION placement.company_drive_defaults(jsonb) TO dsu_placement;

-- company.save stores drive_defaults when the payload carries it.
DO $migration$
DECLARE definition text; pairs text[][]; i integer; occurrences integer;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_mutate(text,jsonb,uuid)'::regprocedure);
  pairs := ARRAY[
    ARRAY['about=CASE WHEN p ? ''about'' THEN',
          'drive_defaults=CASE WHEN p ? ''drive_defaults'' THEN placement.company_drive_defaults(p->''drive_defaults'') ELSE company.drive_defaults END,about=CASE WHEN p ? ''about'' THEN'],
    ARRAY['INSERT INTO placement.companies(about,',
          'INSERT INTO placement.companies(drive_defaults,about,'],
    ARRAY['VALUES(nullif(btrim(p->>''about''),''''),nullif(btrim(p->>''headquarters''),''''),',
          'VALUES(placement.company_drive_defaults(p->''drive_defaults''),nullif(btrim(p->>''about''),''''),nullif(btrim(p->>''headquarters''),''''),']];
  FOR i IN 1..array_length(pairs,1) LOOP
    occurrences := (length(definition) - length(replace(definition, pairs[i][1], ''))) / length(pairs[i][1]);
    IF occurrences <> 1 THEN RAISE EXCEPTION 'Expected one mutate anchor (% found): %', occurrences, left(pairs[i][1],80); END IF;
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  END LOOP;
  EXECUTE definition;
END
$migration$;
NOTIFY pgrst,'reload schema';
