-- Let Postgres inline the cohort helpers.
--
-- These set-returning SQL functions are SECURITY INVOKER, STABLE and fully
-- schema-qualified. Their SET search_path clause was the only thing stopping
-- the planner from inlining them, so every caller materialised the whole
-- cohort (all students, academics and contacts) and filtered afterwards:
-- e.g. student.drive_eligibility computed every candidate of a drive to read
-- one student, and an officer's student profile scanned all students twice.
-- Inlined, a filter such as `WHERE s.id = target` reaches the erp.students
-- primary-key index.
--
-- Safety: built-in functions and operators always resolve from pg_catalog
-- first, every table/function reference in these bodies is schema-qualified,
-- and they run with the caller's privileges (no SECURITY DEFINER), so the
-- pinned search_path protected nothing a caller could not already do. The
-- SECURITY DEFINER functions that call them keep their own search_path=''.
ALTER FUNCTION placement.cohort(jsonb) RESET search_path;
ALTER FUNCTION placement.offer_facts(jsonb) RESET search_path;
ALTER FUNCTION placement.candidates(uuid) RESET search_path;
ALTER FUNCTION placement.audience_members(jsonb) RESET search_path;
ALTER FUNCTION erp.portal_cohort(jsonb) RESET search_path;
ALTER FUNCTION erp.batch_cohort(jsonb) RESET search_path;
ALTER FUNCTION erp.cgpa_ranks(text) RESET search_path;
