-- Drive criteria gain an optional minimum attendance, and publishing a drive
-- notifies ONLY the linked students who meet every criterion (batch, CGPA,
-- current backlogs, branches, attendance and the upward-only offer rule).
ALTER TABLE placement.drives ADD COLUMN min_attendance numeric
  CHECK (min_attendance IS NULL OR min_attendance BETWEEN 0 AND 100);

CREATE OR REPLACE FUNCTION placement.candidates(drive uuid) RETURNS TABLE(
 student_id uuid,usn text,name text,department text,cgpa numeric,backlogs integer,interest text,registration_id uuid,
 eligible boolean,reason text,current_category text,highest_package numeric
) LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT s.id,s.usn,s.name,s.department,s.cgpa,s.backlogs,i.state,r.id,
 s.cgpa BETWEEN d.min_cgpa AND 10 AND s.backlogs BETWEEN 0 AND d.max_backlogs
   AND (cardinality(d.branches)=0 OR s.department=ANY(d.branches))
   AND (d.min_attendance IS NULL OR s.attendance>=d.min_attendance)
   AND coalesce(p.rank,0)<placement.package_rank(d.package_lpa),
 CASE WHEN s.cgpa IS NULL OR s.backlogs IS NULL THEN 'Academic data missing'
 WHEN NOT (s.cgpa BETWEEN d.min_cgpa AND 10) THEN 'CGPA requirement'
 WHEN s.backlogs>d.max_backlogs THEN 'Backlog requirement'
 WHEN cardinality(d.branches)>0 AND (s.department IS NULL OR NOT s.department=ANY(d.branches)) THEN 'Branch requirement'
 WHEN d.min_attendance IS NOT NULL AND (s.attendance IS NULL OR s.attendance<d.min_attendance) THEN 'Attendance requirement'
 WHEN coalesce(p.rank,0)>=placement.package_rank(d.package_lpa) THEN 'Upward-only placement rule'
 ELSE NULL END,placement.package_category(p.highest),p.highest
 FROM placement.drives d CROSS JOIN LATERAL placement.cohort(jsonb_build_object('batch',d.batch)) s
 LEFT JOIN placement.interests i ON i.drive_id=d.id AND i.student_id=s.id
 LEFT JOIN placement.registrations r ON r.drive_id=d.id AND r.student_id=s.id
 LEFT JOIN LATERAL(SELECT max(placement.package_rank(o.package_lpa)) AS rank,max(o.package_lpa) AS highest
 FROM placement.offers o JOIN placement.registrations reg ON reg.id=o.registration_id
 WHERE reg.student_id=s.id AND o.status IN ('offered','accepted')) p ON true WHERE d.id=drive
$$;

-- drive.save accepts min_attendance (blank = no limit; omitted on update = unchanged).
DO $migration$
DECLARE definition text; anchors text[]; anchor text;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_mutate(text,jsonb,uuid)'::regprocedure);
  anchors := ARRAY[
    'WHEN ''drive.save'' THEN',
    'UPDATE placement.drives SET location=CASE WHEN p ? ''location''',
    'INSERT INTO placement.drives(location,',
    'VALUES(nullif(p->>''location'','''')'];
  FOREACH anchor IN ARRAY anchors LOOP
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one drive.save anchor: %', anchor;
    END IF;
  END LOOP;
  definition := replace(definition, anchors[1], anchors[1] || '
   IF nullif(p->>''min_attendance'','''') IS NOT NULL AND (p->>''min_attendance'') !~ ''^(100(\.0+)?|[0-9]{1,2}(\.[0-9]+)?)$'' THEN
     RAISE SQLSTATE ''PT400'' USING MESSAGE=''Minimum attendance must be a number from 0 to 100.'';
   END IF;');
  definition := replace(definition, anchors[2],
    'UPDATE placement.drives SET min_attendance=CASE WHEN p ? ''min_attendance'' THEN nullif(p->>''min_attendance'','''')::numeric ELSE drive.min_attendance END,location=CASE WHEN p ? ''location''');
  definition := replace(definition, anchors[3], 'INSERT INTO placement.drives(min_attendance,location,');
  definition := replace(definition, anchors[4], 'VALUES(nullif(p->>''min_attendance'','''')::numeric,nullif(p->>''location'','''')');
  EXECUTE definition;
END
$migration$;

-- One notice per student per drive, even if the drive is saved again.
CREATE TABLE placement.drive_notices(
  drive_id uuid NOT NULL REFERENCES placement.drives(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES erp.students(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(drive_id, student_id)
);
REVOKE ALL ON placement.drive_notices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON placement.drive_notices TO dsu_placement;

CREATE FUNCTION placement.notify_eligible_students(target uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d placement.drives; company_name text; sent integer;
BEGIN
  SELECT * INTO d FROM placement.drives WHERE id=target;
  IF NOT FOUND OR NOT d.published OR d.status NOT IN ('upcoming','ongoing')
    OR (d.registration_deadline IS NOT NULL AND d.registration_deadline < (now() AT TIME ZONE 'Asia/Kolkata')::date) THEN
    RETURN 0;
  END IF;
  SELECT name INTO company_name FROM placement.companies WHERE id=d.company_id;
  WITH eligible AS (
    SELECT c.student_id, m.user_id FROM placement.candidates(target) c
    JOIN erp.memberships m ON m.student_id=c.student_id AND m.role='student'
    WHERE c.eligible IS TRUE AND c.registration_id IS NULL
  ), fresh AS (
    INSERT INTO placement.drive_notices(drive_id, student_id)
    SELECT target, student_id FROM eligible ON CONFLICT DO NOTHING RETURNING student_id
  ), sent_rows AS (
    INSERT INTO student.notifications(user_id, title, body, href)
    SELECT e.user_id,
      left('New drive for you: ' || coalesce(company_name, 'Campus drive') || ' — ' || d.title, 200),
      d.package_lpa::text || ' LPA'
        || coalesce(' · Register by ' || to_char(d.registration_deadline, 'DD Mon YYYY'), '')
        || ' · You meet the eligibility criteria.',
      '/student/placement?drive=' || target
    FROM eligible e JOIN fresh f ON f.student_id=e.student_id
    RETURNING 1
  )
  SELECT count(*) INTO sent FROM sent_rows;
  RETURN sent;
END $$;
REVOKE ALL ON FUNCTION placement.notify_eligible_students(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION placement.drive_published_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- Publishing, or changing criteria while published, reaches newly eligible students.
  IF NEW.published AND (TG_OP='INSERT' OR NOT OLD.published
    OR NEW.min_cgpa IS DISTINCT FROM OLD.min_cgpa OR NEW.max_backlogs IS DISTINCT FROM OLD.max_backlogs
    OR NEW.branches IS DISTINCT FROM OLD.branches OR NEW.batch IS DISTINCT FROM OLD.batch
    OR NEW.min_attendance IS DISTINCT FROM OLD.min_attendance OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.registration_deadline IS DISTINCT FROM OLD.registration_deadline) THEN
    PERFORM placement.notify_eligible_students(NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION placement.drive_published_notice() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER drive_published_notice AFTER INSERT OR UPDATE ON placement.drives
  FOR EACH ROW EXECUTE FUNCTION placement.drive_published_notice();

-- Officers see how many eligible students were notified on the drive page.
DO $migration$
DECLARE definition text; anchor text := '''counts'',jsonb_build_object(''eligible'',(SELECT count(*) FROM placement.candidates(target) WHERE eligible IS TRUE),';
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_read(text,jsonb)'::regprocedure);
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Expected drive counts projection was not found';
  END IF;
  EXECUTE replace(definition, anchor,
    '''counts'',jsonb_build_object(''notified'',(SELECT count(*) FROM placement.drive_notices WHERE drive_id=target),''eligible'',(SELECT count(*) FROM placement.candidates(target) WHERE eligible IS TRUE),');
END
$migration$;
NOTIFY pgrst,'reload schema';
