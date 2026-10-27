-- Functional defect: overview reports applied student search, while charts
-- silently represented the whole batch/branch. No tables or records change.
-- Preserve the existing aggregation, SECURITY DEFINER owner and grants.
DO $$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('placement.overview_charts(jsonb)'::regprocedure);
  IF position('ARRAY[''batch'',''department'',''search'']' IN definition) = 0 THEN
    IF position('ARRAY[''batch'',''department'']' IN definition) = 0 THEN
      RAISE EXCEPTION 'Overview filter definition changed; review migration before applying';
    END IF;
    definition := replace(definition, 'ARRAY[''batch'',''department'']', 'ARRAY[''batch'',''department'',''search'']');
    definition := replace(definition,
      '''filters'',jsonb_build_object(''batch'',f->>''batch'',''department'',f->>''department'')',
      '''filters'',jsonb_build_object(''batch'',f->>''batch'',''department'',f->>''department'',''search'',f->>''search'')');
    definition := replace(definition, 'passing-out batch and department filters', 'passing-out batch, department and student search filters');
    definition := replace(definition, 'The department filter does not apply', 'Department and student search filters do not apply');
    EXECUTE definition;
  END IF;
END $$;
