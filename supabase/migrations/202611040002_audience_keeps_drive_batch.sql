-- A hand-picked ("selected students only") audience must not rewrite the
-- drive's batch or eligibility fields. Before this, saving one student from
-- batch 2027 on a 2026 drive changed the drive's batch to 2027.
--
-- Rule-based audiences still mirror their rules onto the drive so existing
-- screens show the real criteria. Who is notified never depends on these
-- columns for an audience drive: placement.candidates uses the audience.
CREATE OR REPLACE FUNCTION placement.apply_audience(target uuid,spec jsonb,actor uuid) RETURNS integer
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE clean jsonb:=placement.audience_spec(spec); n integer; selected boolean;
BEGIN
  selected:=clean->>'mode'='selected';
  INSERT INTO placement.drive_audience_rules(drive_id,batches,branches,min_cgpa,max_backlogs,min_attendance,selected_only,updated_by,updated_at)
  VALUES(target,ARRAY(SELECT jsonb_array_elements_text(clean->'batches')),ARRAY(SELECT jsonb_array_elements_text(clean->'branches')),
    (clean->>'min_cgpa')::numeric,(clean->>'max_backlogs')::integer,(clean->>'min_attendance')::numeric,selected,actor,now())
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
  IF selected THEN
    UPDATE placement.drives SET audience_mode=true,updated_at=now() WHERE id=target AND NOT audience_mode;
  ELSE
    -- Drive columns mirror the rules so every existing screen shows real criteria.
    UPDATE placement.drives SET audience_mode=true,
      batch=CASE WHEN EXISTS(SELECT 1 FROM placement.registrations WHERE drive_id=target) THEN batch ELSE clean->'batches'->>0 END,
      branches=ARRAY(SELECT jsonb_array_elements_text(clean->'branches')),
      min_cgpa=coalesce((clean->>'min_cgpa')::numeric,0),max_backlogs=coalesce((clean->>'max_backlogs')::integer,100),
      min_attendance=(clean->>'min_attendance')::numeric,updated_at=now()
    WHERE id=target;
  END IF;
  SELECT count(*) INTO n FROM placement.drive_audience WHERE drive_id=target;
  RETURN n;
END $$;

-- Drive requests list: once a request is approved, show the live drive's
-- batch (what students and the Drives list see), not the batch the company
-- originally requested.
CREATE OR REPLACE FUNCTION placement.drive_requests(q jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM placement.assert_officer();
  RETURN jsonb_build_object(
    'counts',jsonb_build_object('submitted',(SELECT count(*) FROM company.drive_requests WHERE status='submitted'),
      'returned',(SELECT count(*) FROM company.drive_requests WHERE status='returned'),
      'approved',(SELECT count(*) FROM company.drive_requests WHERE status='approved'),
      'rejected',(SELECT count(*) FROM company.drive_requests WHERE status='rejected')),
    'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'status',r.status,'title',r.title,'company',c.name,'companyId',c.id,
      'packageLpa',r.package_lpa,'employmentType',r.employment_type,'openings',r.openings,'submittedAt',r.submitted_at,'reviewedAt',r.reviewed_at,
      'driveId',r.drive_id,'batches',CASE WHEN d.id IS NOT NULL THEN jsonb_build_array(d.batch) ELSE r.criteria->'batches' END)
      ORDER BY (r.status='submitted') DESC,r.submitted_at DESC NULLS LAST,r.id)
      FROM company.drive_requests r JOIN placement.companies c ON c.id=r.company_id
      LEFT JOIN placement.drives d ON d.id=r.drive_id AND r.status='approved'
      WHERE r.status<>'draft' AND (nullif(q->>'status','') IS NULL OR r.status=q->>'status')
        AND (nullif(q->>'search','') IS NULL OR strpos(lower(c.name||' '||coalesce(r.title,'')),lower(q->>'search'))>0)),'[]'));
END $$;
