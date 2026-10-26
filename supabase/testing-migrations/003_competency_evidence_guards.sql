DO $$ BEGIN IF NOT competency.marker_valid() THEN RAISE EXCEPTION 'Testing marker required'; END IF; END $$;
ALTER TABLE competency.evidence ADD COLUMN source_account_id uuid REFERENCES student.platform_accounts(id);
CREATE FUNCTION competency.source_visible(account uuid,target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT account IS NULL OR EXISTS(SELECT 1 FROM student.platform_accounts a JOIN student.skill_profiles p ON p.student_id=a.student_id WHERE a.id=account AND a.student_id=target AND a.visible AND a.state='linked' AND p.consent_version>=1 AND coalesce(p.visibility->'platforms','true'::jsonb)='true'::jsonb)
$$;
CREATE FUNCTION competency.assessment_visible(assessment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM competency.assessment_evidence l JOIN competency.evidence e ON e.id=l.evidence_id WHERE l.assessment_id=assessment AND NOT competency.source_visible(e.source_account_id,e.student_id))
$$;
DROP POLICY scoped_read ON competency.evidence;
CREATE POLICY scoped_read ON competency.evidence FOR SELECT TO dsu_api USING(student_id=erp.actor_student() OR (student.is_officer() AND competency.source_visible(source_account_id,student_id)));
DROP POLICY scoped_read ON competency.assessments;
CREATE POLICY scoped_read ON competency.assessments FOR SELECT TO dsu_api USING(student_id=erp.actor_student() OR (student.is_officer() AND competency.assessment_visible(id)));

-- Reuse already-collected, visible platform measurements. No network access,
-- scraping, credential reads or automatic proficiency inference occurs here.
CREATE FUNCTION competency.import_stored_metrics() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
 DECLARE target uuid:=erp.actor_student(); m record; eid uuid; imported integer:=0; ref text; hash text;
 BEGIN
 IF target IS NULL OR NOT competency.marker_valid() THEN RAISE EXCEPTION 'Linked testing student required'; END IF;
 FOR m IN SELECT p.*,a.platform FROM student.platform_metrics p JOIN student.platform_accounts a ON a.id=p.account_id
 WHERE p.student_id=target AND competency.source_visible(a.id,target) AND p.verification='platform_verified' AND jsonb_typeof(p.value)='number'
 AND p.metric NOT LIKE 'activity.%' AND p.metric NOT LIKE 'contributions.%' ORDER BY p.account_id,p.metric LIMIT 100 LOOP
  ref:='stored-metric:'||m.account_id||':'||m.metric||':'||coalesce(m.snapshot_id::text,m.collected_at::text);
  hash:=md5(m.value::text||m.collected_at::text);
  INSERT INTO competency.metric_definitions(code,name,unit,description) VALUES(m.platform||'.'||m.metric,m.metric,'recorded value','Stored platform measurement; does not establish proficiency.') ON CONFLICT DO NOTHING;
  INSERT INTO competency.evidence(student_id,source_kind,source_ref,title,description,contribution,provenance,review_status,is_synthetic,source_account_id,content_hash,observed_at,expires_at,created_by)
  VALUES(target,'platform_metric',ref,m.platform||' / '||m.metric,m.metric||': '||m.value::text,'Platform account attribution only. Individual project ownership requires review.','platform_verified','pending',false,m.account_id,hash,m.collected_at,m.collected_at+interval '90 days',erp.actor_id())
  ON CONFLICT(student_id,source_kind,source_ref,content_hash) DO NOTHING RETURNING id INTO eid;
  IF eid IS NOT NULL THEN
   INSERT INTO competency.observations(evidence_id,student_id,metric_code,value,observed_at,expires_at) VALUES(eid,target,m.platform||'.'||m.metric,(m.value#>>'{}')::numeric,m.collected_at,m.collected_at+interval '90 days');
   imported:=imported+1;
  END IF;
 END LOOP;
 RETURN imported;
 END $$;
CREATE FUNCTION competency.artifact(evidence uuid) RETURNS TABLE(filename text,content text) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
 BEGIN
 IF NOT competency.reader() THEN RAISE EXCEPTION 'Authorized reader required'; END IF;
 RETURN QUERY SELECT d.filename,d.content FROM competency.evidence e JOIN student.documents d ON d.id=e.artifact_id JOIN erp.memberships m ON m.user_id=d.user_id AND m.student_id=e.student_id
 WHERE e.id=evidence AND (e.student_id=erp.actor_student() OR competency.can('review'));
 END $$;
CREATE FUNCTION competency.validate_assessment() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
 DECLARE a competency.assessments; r competency.rubrics; dimensions integer; expected numeric; aid uuid;
 BEGIN
 aid:=(CASE WHEN TG_TABLE_NAME='assessments' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'assessment_id' END)::uuid;
 SELECT * INTO a FROM competency.assessments WHERE id=aid;
 SELECT * INTO r FROM competency.rubrics WHERE id=a.rubric_id;
 IF a.status='reviewed' AND r.status<>'approved' THEN RAISE EXCEPTION 'Reviewed assessments require an approved rubric'; END IF;
 SELECT count(*),avg(value::numeric) INTO dimensions,expected FROM jsonb_each_text(a.dimensions);
 IF dimensions<>jsonb_array_length(r.definition->'dimensions') OR expected IS NULL OR abs(expected-a.level)>0.000000000001 THEN RAISE EXCEPTION 'Rubric criterion calculation mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.definition->'dimensions') d WHERE NOT(a.dimensions ? (d->>'key'))) OR EXISTS(SELECT 1 FROM jsonb_each_text(a.dimensions) d WHERE d.value::numeric<0 OR d.value::numeric>4 OR trunc(d.value::numeric)<>d.value::numeric) THEN RAISE EXCEPTION 'Invalid rubric criterion values'; END IF;
 IF NOT EXISTS(SELECT 1 FROM competency.assessment_evidence WHERE assessment_id=aid) THEN RAISE EXCEPTION 'Assessment requires attributable evidence'; END IF;
 IF a.status='reviewed' AND EXISTS(SELECT 1 FROM competency.assessment_evidence l JOIN competency.evidence e ON e.id=l.evidence_id WHERE l.assessment_id=aid AND (e.is_synthetic OR e.review_status<>'accepted' OR e.expires_at<=now() OR NOT competency.source_visible(e.source_account_id,e.student_id))) THEN RAISE EXCEPTION 'Current reviewed evidence required'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER assessment_valid AFTER INSERT ON competency.assessments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION competency.validate_assessment();
CREATE CONSTRAINT TRIGGER assessment_link_valid AFTER INSERT ON competency.assessment_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION competency.validate_assessment();
CREATE FUNCTION competency.shortlist_valid() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ DECLARE s competency.snapshots; BEGIN
 SELECT * INTO s FROM competency.snapshots WHERE id=NEW.snapshot_id;
 IF s.is_synthetic OR (s.result->>'coverage')::numeric<(s.result->>'minimumCoverage')::numeric OR EXISTS(SELECT 1 FROM competency.invalidations i WHERE i.student_id=s.student_id AND i.created_at>s.created_at) THEN RAISE EXCEPTION 'Shortlist requires sufficient current non-simulated assessment'; END IF;
 IF EXISTS(SELECT 1 FROM competency.snapshots newer WHERE newer.student_id=s.student_id AND newer.template_id=s.template_id AND newer.created_at>s.created_at) THEN RAISE EXCEPTION 'Use the latest snapshot'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s.result->'inputs') input JOIN competency.assessments a ON a.id=(input->>'assessmentId')::uuid JOIN competency.assessment_evidence l ON l.assessment_id=a.id JOIN competency.evidence e ON e.id=l.evidence_id WHERE e.review_status<>'accepted' OR e.expires_at<=now() OR a.expires_at<=now() OR NOT competency.source_visible(e.source_account_id,e.student_id)) THEN RAISE EXCEPTION 'Evidence must still be current'; END IF;
 IF NEW.state<>'proposed' AND (NEW.approved_by IS NULL OR NEW.approved_by=NEW.created_by) THEN RAISE EXCEPTION 'Independent reviewer required'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER shortlist_valid BEFORE INSERT OR UPDATE ON competency.shortlists FOR EACH ROW EXECUTE FUNCTION competency.shortlist_valid();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA competency FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION competency.source_visible(uuid,uuid),competency.assessment_visible(uuid),competency.import_stored_metrics(),competency.artifact(uuid) TO dsu_api;
