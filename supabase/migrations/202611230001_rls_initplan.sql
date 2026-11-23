-- Row-security performance: evaluate actor helpers once per query.
--
-- Policies called SECURITY DEFINER helpers such as erp.actor_role() and
-- student.is_officer() bare. SECURITY DEFINER functions are never inlined, so
-- Postgres ran them (each a membership lookup) for EVERY row a query scanned,
-- and an OR with a per-row function call also prevented index use. Wrapped as
-- (SELECT fn()) they become an InitPlan: computed once per statement.
--
-- Every helper rewritten here is STABLE and takes no arguments, so its value
-- is fixed for the statement and the result of each policy is unchanged.
-- Policies are rewritten from the catalog, so the policy expressions in the
-- earlier migrations stay the single source of their logic.
DO $$
DECLARE
  p record;
  helpers constant text := '(erp\.actor_role|erp\.actor_student|erp\.actor_id|student\.is_officer|company\.actor_company|company\.is_member|ops\.is_admin|placement\.actor)\(\)';
  -- Skip calls that are already wrapped: "SELECT fn()" as deparsed.
  pattern constant text := '(?<!SELECT )' || helpers;
  using_sql text;
  check_sql text;
  clauses text;
BEGIN
  -- Deparse with every name schema-qualified, so the pattern sees erp.actor_role().
  PERFORM set_config('search_path', '', true);
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_catalog.pg_policies
    WHERE schemaname IN ('erp','student','placement','company','files','ops','ranking','competency')
      AND (qual ~ pattern OR with_check ~ pattern)
  LOOP
    using_sql := pg_catalog.regexp_replace(p.qual, pattern, '(SELECT \1())', 'g');
    check_sql := pg_catalog.regexp_replace(p.with_check, pattern, '(SELECT \1())', 'g');
    clauses := pg_catalog.concat_ws(' ',
      CASE WHEN p.qual IS NOT NULL THEN 'USING (' || using_sql || ')' END,
      CASE WHEN p.with_check IS NOT NULL THEN 'WITH CHECK (' || check_sql || ')' END);
    EXECUTE pg_catalog.format('ALTER POLICY %I ON %I.%I %s', p.policyname, p.schemaname, p.tablename, clauses);
  END LOOP;
END
$$;
