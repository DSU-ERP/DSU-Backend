-- RPC owners remain restricted. JWT claims are set after backend verification.
GRANT EXECUTE ON FUNCTION public.dsu_portal_read(text,jsonb),public.dsu_batch_read(text,jsonb),
  public.dsu_placement_read(text,jsonb),public.dsu_placement_mutate(text,jsonb,uuid) TO dsu_api;
-- Do not modify historical migrations. Remove the second UUID display source.
DO $migration$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_read(text,jsonb)'::regprocedure);
  IF strpos(definition, 'to_jsonb(a)-''fees_paid''-''fees_outstanding''-''fee_category''')=0 THEN
    RAISE EXCEPTION 'Expected academic projection was not found';
  END IF;
  EXECUTE replace(definition, 'to_jsonb(a)-''fees_paid''-''fees_outstanding''-''fee_category''',
    'to_jsonb(a)-''student_id''-''fees_paid''-''fees_outstanding''-''fee_category''');
END
$migration$;
CREATE INDEX IF NOT EXISTS students_batch_enrollment ON erp.students(source_batch,enrollment_no);
CREATE INDEX IF NOT EXISTS placement_events_actor_action_created ON placement.events(actor_id,action,created_at DESC);
CREATE INDEX IF NOT EXISTS placement_requests_actor_created ON placement.requests(actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS placement_messages_conversation_id ON placement.messages(conversation_id,id);
CREATE INDEX IF NOT EXISTS placement_registrations_student ON placement.registrations(student_id,drive_id);
CREATE INDEX IF NOT EXISTS placement_tests_student_completed ON placement.test_results(student_id,tier,completed_at DESC,id);
NOTIFY pgrst,'reload schema';
