-- Persist each small grading batch so provider retries never discard earlier work.
ALTER TABLE student.attempts ADD COLUMN grading jsonb NOT NULL DEFAULT '{}'::jsonb;
