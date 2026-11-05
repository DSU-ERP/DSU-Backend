-- Officers' "submitted a new drive" notices are resolved when the request is
-- approved, returned, rejected or withdrawn, so the bell does not keep showing
-- requests that are no longer awaiting review. Officer notices only.
CREATE OR REPLACE FUNCTION company.request_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE company_name text; label text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  -- A request that is no longer awaiting review no longer needs officers' attention.
  IF OLD.status='submitted' AND NEW.status<>'submitted' THEN
    UPDATE erp.notifications SET read_at=now()
    WHERE audience='officer' AND kind='request.submitted' AND entity_type='drive_request' AND entity_id=NEW.id AND read_at IS NULL;
  END IF;
  SELECT name INTO company_name FROM placement.companies WHERE id=NEW.company_id;
  label:=coalesce(NEW.title,'Untitled drive');
  IF NEW.status='submitted' THEN
    PERFORM erp.notify_officers('request.submitted',
      CASE WHEN NEW.kind='change' THEN company_name||' requested changes to '||label ELSE company_name||' submitted a new drive: '||label END,
      CASE WHEN NEW.kind='change' THEN 'Review the changes before they reach students.' ELSE 'Review the drive and choose who receives it.' END,
      '/placement/drive-requests/'||NEW.id,'drive_request',NEW.id);
  ELSIF OLD.status='submitted' AND NEW.status IN ('approved','returned','rejected') THEN
    PERFORM erp.notify_company(NEW.company_id,'request.'||NEW.status,
      CASE NEW.status WHEN 'approved' THEN CASE WHEN NEW.kind='change' THEN 'Changes approved: '||label ELSE 'Drive approved: '||label END
        WHEN 'returned' THEN 'Changes requested: '||label ELSE 'Drive not approved: '||label END,
      CASE NEW.status WHEN 'approved' THEN CASE WHEN NEW.kind='change' THEN 'The live drive now shows your changes.'
          ELSE 'The placement office approved the drive and shared it with the students it selected.' END
        ELSE coalesce(NEW.review_comment,'See the placement office''s comment.') END,
      CASE WHEN NEW.status='approved' AND NEW.drive_id IS NOT NULL THEN '/company/drives/'||NEW.drive_id ELSE '/company/requests/'||NEW.id END,
      'drive_request',NEW.id);
  END IF;
  RETURN NULL;
END $$;

-- Resolve notices already left behind by decided requests.
UPDATE erp.notifications n SET read_at=now()
FROM company.drive_requests r
WHERE n.audience='officer' AND n.kind='request.submitted' AND n.entity_type='drive_request' AND n.entity_id=r.id
  AND n.read_at IS NULL AND r.status<>'submitted';
