-- Assessment intelligence (additive).
-- 1. AI performance diagnosis stored with the attempt it describes. Only the
--    owning student writes it (existing student_own policy); officers can read
--    attempts of assigned tests through officer_assessment_results.
ALTER TABLE student.attempts ADD COLUMN insights jsonb
  CHECK (insights IS NULL OR jsonb_typeof(insights) = 'object');

-- 2. Display name of an assigned test's author for the student instructions
--    screen. Students cannot read auth.users, so this definer function returns
--    only the name (profile full name, else the email local part) and only for
--    an assigned test the caller could already open: an officer, or a student
--    of the published test's batch.
CREATE FUNCTION student.assessment_creator(assessment uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    nullif(btrim(left(u.raw_user_meta_data->>'full_name', 200)), ''),
    nullif(split_part(u.email, '@', 1), ''))
  FROM student.assessments a JOIN auth.users u ON u.id = a.creator_id
  WHERE a.id = assessment AND a.kind = 'assigned'
    AND (student.is_officer() OR (a.published AND (a.batch IS NULL OR
      a.batch = (SELECT s.source_batch FROM erp.students s WHERE s.id = erp.actor_student()))))
$$;
REVOKE ALL ON FUNCTION student.assessment_creator(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION student.assessment_creator(uuid) TO dsu_api;
NOTIFY pgrst, 'reload schema';
