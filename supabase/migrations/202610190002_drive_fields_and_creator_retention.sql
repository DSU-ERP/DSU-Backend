-- 1. Saving a drive no longer unpublishes it or clears the student-facing
--    fields when a client omits them (older web releases, scripted callers).
--    The current editor always sends "published" explicitly.
DO $migration$
DECLARE definition text; before_text text; after_text text;
BEGIN
  definition := pg_get_functiondef('public.dsu_placement_mutate(text,jsonb,uuid)'::regprocedure);
  before_text := 'UPDATE placement.drives SET location=nullif(p->>''location'',''''),skills=coalesce(p->>''skills'',''''),required_documents=coalesce(p->>''required_documents'',''''),original_pdf_url=nullif(p->>''original_pdf_url'',''''),published=coalesce((p->>''published'')::boolean,false),';
  after_text := 'UPDATE placement.drives SET location=CASE WHEN p ? ''location'' THEN nullif(p->>''location'','''') ELSE drive.location END,'
    || 'skills=CASE WHEN p ? ''skills'' THEN coalesce(p->>''skills'','''') ELSE drive.skills END,'
    || 'required_documents=CASE WHEN p ? ''required_documents'' THEN coalesce(p->>''required_documents'','''') ELSE drive.required_documents END,'
    || 'original_pdf_url=CASE WHEN p ? ''original_pdf_url'' THEN nullif(p->>''original_pdf_url'','''') ELSE drive.original_pdf_url END,'
    || 'published=coalesce((p->>''published'')::boolean,drive.published),';
  IF strpos(definition, before_text) = 0 THEN
    RAISE EXCEPTION 'Expected drive.save update statement was not found';
  END IF;
  EXECUTE replace(definition, before_text, after_text);
END
$migration$;

-- 2. Removing an officer's Auth account must not delete student assessment
--    results (assessments cascade to attempts) or fail because the officer
--    created calendar events or notices. Keep the rows; clear the creator.
DO $migration$
DECLARE item record; constraint_name text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('assessments','creator_id'),('calendar_events','created_by'),('broadcasts','creator_id')) AS t(table_name,column_name)
  LOOP
    SELECT c.conname INTO constraint_name FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
      WHERE c.contype='f' AND c.conrelid=format('student.%I',item.table_name)::regclass
        AND cardinality(c.conkey)=1 AND a.attname=item.column_name;
    IF constraint_name IS NULL THEN
      RAISE EXCEPTION 'Foreign key for student.%.% was not found', item.table_name, item.column_name;
    END IF;
    EXECUTE format('ALTER TABLE student.%I ALTER COLUMN %I DROP NOT NULL', item.table_name, item.column_name);
    EXECUTE format('ALTER TABLE student.%I DROP CONSTRAINT %I', item.table_name, constraint_name);
    EXECUTE format('ALTER TABLE student.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES auth.users(id) ON DELETE SET NULL',
      item.table_name, constraint_name, item.column_name);
  END LOOP;
END
$migration$;
NOTIFY pgrst,'reload schema';
