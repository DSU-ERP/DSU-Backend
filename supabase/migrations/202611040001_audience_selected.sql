-- Drive audiences: count a student once when the filters and a hand-picked
-- addition both include them, and let officers publish to only the students
-- they select (the filters are then ignored).
--
-- Before this, a student matching the filters and also added by hand came out
-- of audience_members twice ('rules' and 'added'). The preview counted them
-- twice and saving failed: ON CONFLICT DO UPDATE cannot affect a row twice.

ALTER TABLE placement.drive_audience_rules ADD COLUMN selected_only boolean NOT NULL DEFAULT false;

-- spec: {mode,batches[],branches[],min_cgpa,max_backlogs,min_attendance,add[],remove[]}
-- mode 'selected': the audience is exactly `add`; batches are taken from those
-- students so the drive keeps a real batch and academic year.
CREATE OR REPLACE FUNCTION placement.audience_spec(spec jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE mode text; batches text[]; branches text[]; added uuid[]; removed uuid[]; result jsonb;
BEGIN
  IF spec IS NULL OR jsonb_typeof(spec)<>'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose the drive audience.'; END IF;
  IF jsonb_typeof(coalesce(spec->'batches','[]'))<>'array' OR jsonb_typeof(coalesce(spec->'branches','[]'))<>'array'
    OR jsonb_typeof(coalesce(spec->'add','[]'))<>'array' OR jsonb_typeof(coalesce(spec->'remove','[]'))<>'array' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Audience lists must be arrays.';
  END IF;
  mode:=coalesce(nullif(spec->>'mode',''),'rules');
  IF mode NOT IN ('rules','selected') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose filters or selected students.'; END IF;
  added:=ARRAY(SELECT DISTINCT v::uuid FROM jsonb_array_elements_text(coalesce(spec->'add','[]')) v);
  removed:=ARRAY(SELECT DISTINCT v::uuid FROM jsonb_array_elements_text(coalesce(spec->'remove','[]')) v);
  IF cardinality(added)>5000 OR cardinality(removed)>5000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Too many individual changes.'; END IF;
  IF mode='selected' THEN
    IF cardinality(added)=0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Select at least one student.'; END IF;
    batches:=ARRAY(SELECT DISTINCT s.source_batch FROM erp.students s WHERE s.id=ANY(added) AND s.source_batch ~ '^20[0-9]{2}$' ORDER BY 1);
    IF cardinality(batches)=0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='The selected students were not found.'; END IF;
    IF cardinality(batches)>10 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Selected students can span at most ten batches.'; END IF;
    RETURN jsonb_build_object('mode','selected','batches',to_jsonb(batches),'branches','[]'::jsonb,
      'min_cgpa',NULL,'max_backlogs',NULL,'min_attendance',NULL,'add',to_jsonb(added),'remove','[]'::jsonb);
  END IF;
  batches:=ARRAY(SELECT DISTINCT v FROM jsonb_array_elements_text(coalesce(spec->'batches','[]')) v ORDER BY 1);
  branches:=ARRAY(SELECT DISTINCT btrim(v) FROM jsonb_array_elements_text(coalesce(spec->'branches','[]')) v WHERE btrim(v)<>'' ORDER BY 1);
  IF cardinality(batches) NOT BETWEEN 1 AND 10 OR EXISTS(SELECT 1 FROM unnest(batches) b WHERE b !~ '^20[0-9]{2}$') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Choose one to ten graduating batches.';
  END IF;
  IF cardinality(branches)>100 OR EXISTS(SELECT 1 FROM unnest(branches) b WHERE length(b)>100) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Too many branches.';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(added) a WHERE a=ANY(removed)) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='A student cannot be both added and removed.';
  END IF;
  result:=jsonb_build_object('mode','rules','batches',to_jsonb(batches),'branches',to_jsonb(branches),
    'min_cgpa',CASE WHEN nullif(spec->>'min_cgpa','') IS NULL THEN NULL ELSE (spec->>'min_cgpa')::numeric END,
    'max_backlogs',CASE WHEN nullif(spec->>'max_backlogs','') IS NULL THEN NULL ELSE (spec->>'max_backlogs')::integer END,
    'min_attendance',CASE WHEN nullif(spec->>'min_attendance','') IS NULL THEN NULL ELSE (spec->>'min_attendance')::numeric END,
    'add',to_jsonb(added),'remove',to_jsonb(removed));
  IF (result->>'min_cgpa')::numeric NOT BETWEEN 0 AND 10 OR (result->>'max_backlogs')::integer NOT BETWEEN 0 AND 100
    OR (result->>'min_attendance')::numeric NOT BETWEEN 0 AND 100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Check the CGPA, backlog and attendance limits.';
  END IF;
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='Check the CGPA, backlog and attendance limits and the selected students.';
END $$;

-- One row per student. A hand-picked student the filters already include is
-- a 'rules' member; in 'selected' mode only the picked students are members.
CREATE OR REPLACE FUNCTION placement.audience_members(spec jsonb) RETURNS TABLE(student_id uuid,source text) LANGUAGE sql STABLE SET search_path='' AS $$
  WITH rules AS (
    SELECT s.id FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
    WHERE coalesce(spec->>'mode','rules')<>'selected'
      AND s.source_batch IN (SELECT jsonb_array_elements_text(spec->'batches'))
      AND (jsonb_array_length(spec->'branches')=0 OR s.department_short_name IN (SELECT jsonb_array_elements_text(spec->'branches')))
      AND (spec->>'min_cgpa' IS NULL OR a.cgpa>=(spec->>'min_cgpa')::numeric)
      AND (spec->>'max_backlogs' IS NULL OR a.current_backlog<=(spec->>'max_backlogs')::integer)
      AND (spec->>'min_attendance' IS NULL OR a.attendance>=(spec->>'min_attendance')::numeric)
      AND s.id::text NOT IN (SELECT jsonb_array_elements_text(spec->'remove')))
  SELECT id,'rules'::text FROM rules
  UNION ALL
  SELECT s.id,'added' FROM erp.students s
  WHERE s.id::text IN (SELECT jsonb_array_elements_text(spec->'add')) AND s.id NOT IN (SELECT id FROM rules)
$$;

-- Same as before, and records whether the audience is selected students only.
CREATE OR REPLACE FUNCTION placement.apply_audience(target uuid,spec jsonb,actor uuid) RETURNS integer
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE clean jsonb:=placement.audience_spec(spec); n integer;
BEGIN
  INSERT INTO placement.drive_audience_rules(drive_id,batches,branches,min_cgpa,max_backlogs,min_attendance,selected_only,updated_by,updated_at)
  VALUES(target,ARRAY(SELECT jsonb_array_elements_text(clean->'batches')),ARRAY(SELECT jsonb_array_elements_text(clean->'branches')),
    (clean->>'min_cgpa')::numeric,(clean->>'max_backlogs')::integer,(clean->>'min_attendance')::numeric,clean->>'mode'='selected',actor,now())
  ON CONFLICT(drive_id) DO UPDATE SET batches=EXCLUDED.batches,branches=EXCLUDED.branches,min_cgpa=EXCLUDED.min_cgpa,
    max_backlogs=EXCLUDED.max_backlogs,min_attendance=EXCLUDED.min_attendance,selected_only=EXCLUDED.selected_only,updated_by=actor,updated_at=now();
  DELETE FROM placement.drive_audience_overrides WHERE drive_id=target;
  INSERT INTO placement.drive_audience_overrides(drive_id,student_id,action,recorded_by)
  SELECT target,v::uuid,'add',actor FROM jsonb_array_elements_text(clean->'add') v
  UNION ALL SELECT target,v::uuid,'remove',actor FROM jsonb_array_elements_text(clean->'remove') v;
  DELETE FROM placement.drive_audience a WHERE a.drive_id=target
    AND NOT EXISTS(SELECT 1 FROM placement.audience_members(clean) m WHERE m.student_id=a.student_id);
  INSERT INTO placement.drive_audience(drive_id,student_id,source)
  SELECT target,m.student_id,m.source FROM placement.audience_members(clean) m
  ON CONFLICT(drive_id,student_id) DO UPDATE SET source=EXCLUDED.source;
  -- Drive columns mirror the rules so every existing screen shows real criteria.
  UPDATE placement.drives SET audience_mode=true,
    batch=CASE WHEN EXISTS(SELECT 1 FROM placement.registrations WHERE drive_id=target) THEN batch ELSE clean->'batches'->>0 END,
    branches=ARRAY(SELECT jsonb_array_elements_text(clean->'branches')),
    min_cgpa=coalesce((clean->>'min_cgpa')::numeric,0),max_backlogs=coalesce((clean->>'max_backlogs')::integer,100),
    min_attendance=(clean->>'min_attendance')::numeric,updated_at=now()
  WHERE id=target;
  SELECT count(*) INTO n FROM placement.drive_audience WHERE drive_id=target;
  RETURN n;
END $$;
