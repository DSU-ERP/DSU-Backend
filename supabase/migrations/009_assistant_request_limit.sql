-- Disambiguate the audit column from the RPC's action parameter.
DO $migration$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_mutate(text,jsonb,uuid)'::regprocedure);
  IF strpos(definition, 'AND action=''assistant.request''') = 0 THEN
    RAISE EXCEPTION 'Expected assistant request limiter was not found';
  END IF;
  EXECUTE replace(definition, 'AND action=''assistant.request''', 'AND placement.events.action=''assistant.request''');
END
$migration$;
NOTIFY pgrst,'reload schema';
