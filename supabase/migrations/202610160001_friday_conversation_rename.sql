-- Rename only the signed-in officer's own Friday conversation. Existing RLS
-- remains enforced by the restricted function owner; messages are untouched.
CREATE FUNCTION public.dsu_friday_rename(conversation_id uuid,new_title text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE actor uuid; title_value text:=btrim(new_title); result jsonb;
BEGIN
  actor:=placement.assert_officer();
  IF conversation_id IS NULL OR title_value IS NULL OR length(title_value) NOT BETWEEN 1 AND 120
    OR new_title ~ '[[:cntrl:]]' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='Enter a conversation name of 1–120 characters on one line.';
  END IF;
  UPDATE placement.conversations c SET title=title_value,updated_at=now()
    WHERE c.id=conversation_id AND c.owner_id=actor AND c.assistant='friday'
    RETURNING jsonb_build_object('id',c.id,'title',c.title,'updated_at',c.updated_at) INTO result;
  IF result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Conversation not found.'; END IF;
  RETURN jsonb_build_object('data',result);
END $$;
GRANT CREATE ON SCHEMA public TO dsu_placement;
ALTER FUNCTION public.dsu_friday_rename(uuid,text) OWNER TO dsu_placement;
REVOKE CREATE ON SCHEMA public FROM dsu_placement;
REVOKE ALL ON FUNCTION public.dsu_friday_rename(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dsu_friday_rename(uuid,text) TO authenticated;
NOTIFY pgrst,'reload schema';
