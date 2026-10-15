-- Evaluate the candidate cohort once while the transaction holds the placement
-- write lock. Calling the table function for every selected student was quadratic.
DO $migration$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_mutate(text,jsonb,uuid)'::regprocedure);
  IF strpos(definition, 'student uuid; ids uuid[];') = 0
     OR strpos(definition, 'IF NOT EXISTS(SELECT 1 FROM placement.candidates(drive.id) c WHERE c.student_id=student AND c.eligible IS TRUE)') = 0 THEN
    RAISE EXCEPTION 'Expected candidate validation was not found';
  END IF;
  definition := replace(definition, 'student uuid; ids uuid[];', 'student uuid; ids uuid[]; eligible_ids uuid[];');
  definition := replace(definition, 'IF action=''registration.interested'' THEN',
    'eligible_ids:=ARRAY(SELECT student_id FROM placement.candidates(drive.id) WHERE eligible IS TRUE); IF action=''registration.interested'' THEN');
  definition := replace(definition,
    'IF NOT EXISTS(SELECT 1 FROM placement.candidates(drive.id) c WHERE c.student_id=student AND c.eligible IS TRUE)',
    'IF NOT (student=ANY(eligible_ids))');
  EXECUTE definition;
END
$migration$;
NOTIFY pgrst,'reload schema';
