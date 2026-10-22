-- Interview intelligence: cached post-interview coaching per answer and the
-- AI's structured reading of the plan's JD and resume. Additive only; the
-- existing student_own RLS policies and table grants already cover new columns.
ALTER TABLE student.interview_answers
  ADD COLUMN coaching jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(coaching) = 'object');
ALTER TABLE student.interviews
  ADD COLUMN context jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(context) = 'object');
