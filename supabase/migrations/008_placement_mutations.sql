CREATE FUNCTION public.dsu_placement_mutate(action text,payload jsonb,request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='20s' AS $$
DECLARE actor uuid; p jsonb:=payload; result jsonb:='{}'; old_request placement.requests; target uuid;
 company placement.companies; drive placement.drives; reg placement.registrations; offer placement.offers;
 student uuid; ids uuid[]; round_no integer; outcome text; next_status text; price numeric; changed integer:=0;
 names text[]; chosen_branches text[]; revision_no integer; conversation uuid; item jsonb; proposal placement.proposals;
BEGIN
 actor:=placement.assert_officer();
 IF request_id IS NULL OR p IS NULL OR jsonb_typeof(p)<>'object' OR octet_length(p::text)>262144 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid request.'; END IF;
 -- Serializes concurrent eligibility/offer transitions and idempotent retries across officers.
 -- Reads remain concurrent. The transaction rolls back fully on any failed selection.
 PERFORM pg_advisory_xact_lock(hashtext('placement.write'));
 SELECT * INTO old_request FROM placement.requests WHERE actor_id=actor AND placement.requests.request_id=dsu_placement_mutate.request_id;
 IF FOUND THEN
   IF old_request.action<>action OR old_request.payload<>p THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Request key was reused with different data.'; END IF;
   RETURN old_request.response;
 END IF;
 IF (SELECT count(*) FROM placement.requests WHERE actor_id=actor AND created_at>now()-interval '1 minute')>=120 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='Too many changes. Please wait a moment.'; END IF;
 target:=nullif(p->>'id','')::uuid; revision_no:=nullif(p->>'revision','')::integer;
 CASE action
 WHEN 'assistant.request' THEN
   IF (SELECT count(*) FROM placement.events WHERE actor_id=actor AND action='assistant.request' AND created_at>now()-interval '1 minute')>=20 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='Please wait before making another assistant request.'; END IF;
   result:=jsonb_build_object('allowed',true);
 WHEN 'company.save' THEN
   IF target IS NOT NULL THEN
     SELECT * INTO company FROM placement.companies WHERE id=target FOR UPDATE;
     IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Company not found.'; END IF;
     IF revision_no IS DISTINCT FROM company.revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Company changed. Reload before saving.'; END IF;
     UPDATE placement.companies SET name=btrim(p->>'name'),short_name=nullif(btrim(p->>'short_name'),''),industry=nullif(btrim(p->>'industry'),''),
       website=nullif(btrim(p->>'website'),''),hr_name=nullif(btrim(p->>'hr_name'),''),hr_email=nullif(btrim(p->>'hr_email'),''),hr_phone=nullif(btrim(p->>'hr_phone'),''),
       active=coalesce((p->>'active')::boolean,true),revision=revision+1,updated_at=now() WHERE id=target RETURNING to_jsonb(placement.companies.*) INTO result;
   ELSE
     INSERT INTO placement.companies(name,short_name,industry,website,hr_name,hr_email,hr_phone,active)
       VALUES(btrim(p->>'name'),nullif(btrim(p->>'short_name'),''),nullif(btrim(p->>'industry'),''),nullif(btrim(p->>'website'),''),
       nullif(btrim(p->>'hr_name'),''),nullif(btrim(p->>'hr_email'),''),nullif(btrim(p->>'hr_phone'),''),coalesce((p->>'active')::boolean,true)) RETURNING id,to_jsonb(placement.companies.*) INTO target,result;
   END IF;
 WHEN 'company.delete' THEN
   SELECT * INTO company FROM placement.companies WHERE id=target FOR UPDATE;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Company not found.'; END IF;
   IF revision_no IS DISTINCT FROM company.revision OR p->>'confirmation' IS DISTINCT FROM company.name THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Type the current company name to confirm deletion.'; END IF;
   DELETE FROM placement.companies WHERE id=target; result:=jsonb_build_object('deleted',true);
 WHEN 'drive.save' THEN
   names:=ARRAY(SELECT btrim(value) FROM jsonb_array_elements_text(p->'rounds'));
   chosen_branches:=ARRAY(SELECT DISTINCT btrim(value) FROM jsonb_array_elements_text(coalesce(p->'branches','[]')));
   IF cardinality(names) NOT BETWEEN 1 AND 20 OR EXISTS(SELECT 1 FROM unnest(names) n WHERE length(n) NOT BETWEEN 1 AND 100)
   OR EXISTS(SELECT 1 FROM unnest(chosen_branches) n WHERE length(n) NOT BETWEEN 1 AND 100)
   OR cardinality(names)<>(SELECT count(DISTINCT n) FROM unnest(names)n) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Provide one to twenty distinct round names.'; END IF;
   SELECT * INTO company FROM placement.companies WHERE id=(p->>'company_id')::uuid;
   IF NOT FOUND OR NOT company.active THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose an active company.'; END IF;
   IF target IS NOT NULL THEN
     SELECT * INTO drive FROM placement.drives WHERE id=target FOR UPDATE;
     IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
     IF revision_no IS DISTINCT FROM drive.revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Drive changed. Reload before saving.'; END IF;
     IF (drive.rounds<>names OR drive.batch IS DISTINCT FROM p->>'batch' OR drive.company_id<>company.id)
       AND EXISTS(SELECT 1 FROM placement.registrations WHERE drive_id=target) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Company, batch and rounds are locked after registration starts.'; END IF;
     UPDATE placement.drives SET company_id=company.id,title=btrim(p->>'title'),description=coalesce(p->>'description',''),package_lpa=(p->>'package_lpa')::numeric,
       academic_year=p->>'academic_year',batch=p->>'batch',min_cgpa=(p->>'min_cgpa')::numeric,max_backlogs=(p->>'max_backlogs')::integer,branches=chosen_branches,
       rounds=names,drive_date=nullif(p->>'drive_date','')::date,registration_deadline=nullif(p->>'registration_deadline','')::date,
       status=coalesce(p->>'status','upcoming'),revision=revision+1,updated_at=now() WHERE id=target RETURNING to_jsonb(placement.drives.*) INTO result;
   ELSE
     INSERT INTO placement.drives(company_id,title,description,package_lpa,academic_year,batch,min_cgpa,max_backlogs,branches,rounds,drive_date,registration_deadline,status)
       VALUES(company.id,btrim(p->>'title'),coalesce(p->>'description',''),(p->>'package_lpa')::numeric,p->>'academic_year',p->>'batch',
       (p->>'min_cgpa')::numeric,(p->>'max_backlogs')::integer,chosen_branches,names,nullif(p->>'drive_date','')::date,nullif(p->>'registration_deadline','')::date,coalesce(p->>'status','upcoming'))
       RETURNING id,to_jsonb(placement.drives.*) INTO target,result;
   END IF;
 WHEN 'drive.delete' THEN
   SELECT * INTO drive FROM placement.drives WHERE id=target FOR UPDATE;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
   IF revision_no IS DISTINCT FROM drive.revision OR p->>'confirmation' IS DISTINCT FROM drive.title THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Type the current drive title to confirm deletion.'; END IF;
   DELETE FROM placement.drives WHERE id=target; result:=jsonb_build_object('deleted',true);
 WHEN 'interest.record','registration.add','registration.interested' THEN
   SELECT * INTO drive FROM placement.drives WHERE id=(p->>'drive_id')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
   IF drive.status NOT IN ('upcoming','ongoing') OR (drive.registration_deadline IS NOT NULL AND drive.registration_deadline<(now() AT TIME ZONE 'Asia/Kolkata')::date) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Registration is closed for this drive.'; END IF;
   IF action='registration.interested' THEN
     ids:=ARRAY(SELECT student_id FROM placement.candidates(drive.id) WHERE eligible IS TRUE AND interest='interested' AND registration_id IS NULL ORDER BY student_id);
   ELSE ids:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(p->'student_ids')); END IF;
   IF cardinality(ids)>10000 OR (cardinality(ids)=0 AND action<>'registration.interested') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Select at least one student.'; END IF;
   FOREACH student IN ARRAY ids LOOP
     IF NOT EXISTS(SELECT 1 FROM placement.candidates(drive.id) c WHERE c.student_id=student AND c.eligible IS TRUE) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='A selected student no longer meets academic or upward-only requirements.'; END IF;
     IF action='interest.record' THEN
       INSERT INTO placement.interests(drive_id,student_id,state,recorded_by) VALUES(drive.id,student,p->>'state',actor)
        ON CONFLICT(drive_id,student_id) DO UPDATE SET state=EXCLUDED.state,recorded_by=actor,recorded_at=now();
     ELSE
       IF NOT coalesce((p->>'override_interest')::boolean,false)
         AND NOT EXISTS(SELECT 1 FROM placement.interests WHERE drive_id=drive.id AND student_id=student AND state='interested') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Record interest or explicitly confirm the interest override.'; END IF;
       INSERT INTO placement.registrations(drive_id,student_id,interest_override) VALUES(drive.id,student,coalesce((p->>'override_interest')::boolean,false)) ON CONFLICT(drive_id,student_id) DO NOTHING;
       IF NOT FOUND THEN CONTINUE; END IF;
     END IF;
     INSERT INTO placement.events(actor_id,action,student_id,drive_id,details) VALUES(actor,action,student,drive.id,jsonb_build_object('interest',p->>'state','override',coalesce((p->>'override_interest')::boolean,false)));
     changed:=changed+1;
   END LOOP;
   target:=drive.id; result:=jsonb_build_object('count',changed,'drive_id',drive.id);
 WHEN 'round.record','registration.withdraw','offer.create' THEN
   ids:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(p->'registration_ids'));
   IF cardinality(ids) NOT BETWEEN 1 AND 500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Select between one and 500 registrations.'; END IF;
   FOREACH target IN ARRAY ids LOOP
     SELECT * INTO reg FROM placement.registrations WHERE id=target FOR UPDATE;
     IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Registration not found.'; END IF;
     SELECT * INTO drive FROM placement.drives WHERE id=reg.drive_id FOR UPDATE;
     IF drive.id IS DISTINCT FROM (p->>'drive_id')::uuid THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Selections must belong to this drive.'; END IF;
     IF drive.status='cancelled' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='This drive is cancelled.'; END IF;
     IF action='round.record' THEN
       round_no:=(p->>'round')::integer; outcome:=p->>'result';
       IF outcome NOT IN ('pass','fail','absent') OR outcome IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Choose pass, fail or absent.'; END IF;
       IF round_no IS DISTINCT FROM reg.current_round OR reg.status NOT IN ('registered','in-progress') OR round_no>cardinality(drive.rounds) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='A selection is not awaiting this round. Refresh the student pool.'; END IF;
       INSERT INTO placement.round_results(registration_id,round_number,round_name,result,remarks,recorded_by) VALUES(reg.id,round_no,drive.rounds[round_no],outcome,coalesce(p->>'remarks',''),actor);
       next_status:=CASE WHEN outcome<>'pass' THEN 'rejected' WHEN round_no=cardinality(drive.rounds) THEN 'selected' ELSE 'in-progress' END;
       UPDATE placement.registrations SET status=next_status,current_round=CASE WHEN outcome='pass' THEN current_round+1 ELSE current_round END,revision=revision+1,updated_at=now() WHERE id=reg.id;
     ELSIF action='registration.withdraw' THEN
       IF reg.status NOT IN ('registered','in-progress','selected') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Only active candidates without an offer can be withdrawn.'; END IF;
       UPDATE placement.registrations SET status='withdrawn',revision=revision+1,updated_at=now() WHERE id=reg.id;
     ELSE
       IF reg.status<>'selected' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='All rounds must be passed before an offer can be created.'; END IF;
       price:=coalesce(nullif(p->>'package_lpa','')::numeric,drive.package_lpa);
       IF EXISTS(SELECT 1 FROM placement.offers o JOIN placement.registrations r ON r.id=o.registration_id WHERE r.student_id=reg.student_id AND o.status IN ('offered','accepted') AND placement.package_rank(o.package_lpa)>=placement.package_rank(price)) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='The new offer must be in a higher package category.'; END IF;
       INSERT INTO placement.offers(registration_id,package_lpa) VALUES(reg.id,price);
       UPDATE placement.registrations SET status='placed',revision=revision+1,updated_at=now() WHERE id=reg.id;
     END IF;
     INSERT INTO placement.events(actor_id,action,resource_id,student_id,drive_id,details) VALUES(actor,action,reg.id,reg.student_id,drive.id,
       jsonb_build_object('round',round_no,'result',outcome,'package_lpa',price));
     changed:=changed+1;
   END LOOP;
   result:=jsonb_build_object('count',changed);
 WHEN 'offer.decide' THEN
   SELECT * INTO offer FROM placement.offers WHERE id=target FOR UPDATE;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Offer not found.'; END IF;
   next_status:=p->>'status';
   IF revision_no IS DISTINCT FROM offer.revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Offer changed. Reload before updating.'; END IF;
   IF next_status NOT IN ('accepted','declined','revoked') OR next_status IS NULL OR offer.status IN ('declined','revoked') OR (offer.status='accepted' AND next_status<>'revoked') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='This offer decision is not available.'; END IF;
   UPDATE placement.offers SET status=next_status,revision=revision+1,updated_at=now() WHERE id=target RETURNING to_jsonb(placement.offers.*) INTO result;
   SELECT * INTO reg FROM placement.registrations WHERE id=offer.registration_id;
   INSERT INTO placement.events(actor_id,action,resource_id,student_id,drive_id,details) VALUES(actor,action,target,reg.student_id,reg.drive_id,jsonb_build_object('from',offer.status,'to',next_status));
 WHEN 'conversation.create' THEN
   INSERT INTO placement.conversations(owner_id,title,assistant) VALUES(actor,left(coalesce(nullif(p->>'title',''),'New conversation'),120),p->>'assistant') RETURNING id INTO target;
   result:=jsonb_build_object('id',target);
 WHEN 'conversation.delete' THEN
   DELETE FROM placement.conversations WHERE id=target AND owner_id=actor;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Conversation not found.'; END IF;
   result:=jsonb_build_object('deleted',true);
 WHEN 'conversation.append' THEN
   conversation:=(p->>'conversation_id')::uuid;
   PERFORM 1 FROM placement.conversations WHERE id=conversation AND owner_id=actor FOR UPDATE;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Conversation not found.'; END IF;
   IF (SELECT count(*) FROM placement.messages WHERE conversation_id=conversation)>=200 THEN RAISE SQLSTATE 'PT413' USING MESSAGE='Start a new conversation to continue.'; END IF;
   INSERT INTO placement.messages(conversation_id,role,content) VALUES(conversation,'user',p->>'user'),(conversation,'assistant',p->>'assistant');
   UPDATE placement.conversations SET updated_at=now() WHERE id=conversation; result:=jsonb_build_object('id',conversation);
 WHEN 'proposal.create' THEN
   INSERT INTO placement.proposals(owner_id,kind,payload) VALUES(actor,p->>'kind',p->'payload') RETURNING id INTO target;
   result:=jsonb_build_object('id',target);
 WHEN 'proposal.cancel','proposal.claim','proposal.finish' THEN
   SELECT * INTO proposal FROM placement.proposals WHERE id=target AND owner_id=actor FOR UPDATE;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Action not found.'; END IF;
   IF action='proposal.finish' AND proposal.state<>'confirmed' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Action has not been confirmed or was already finished.'; END IF;
   IF action<>'proposal.finish' AND (proposal.state<>'pending' OR proposal.expires_at<now()) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='Action expired or was already handled.'; END IF;
   UPDATE placement.proposals SET state=CASE action WHEN 'proposal.cancel' THEN 'cancelled' WHEN 'proposal.claim' THEN 'confirmed' ELSE CASE WHEN p->>'success'='true' THEN 'completed' ELSE 'failed' END END WHERE id=target;
   result:=to_jsonb(proposal);
 ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='Unknown placement action.';
 END CASE;
 INSERT INTO placement.events(actor_id,action,resource_id) VALUES(actor,action,target);
 result:=jsonb_build_object('data',result);
 INSERT INTO placement.requests(actor_id,request_id,action,payload,response) VALUES(actor,request_id,action,p,result);
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR check_violation OR not_null_violation THEN
 RAISE SQLSTATE 'PT400' USING MESSAGE='Check the required fields, dates and numeric ranges.';
 WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='This record already exists. Refresh before trying again.';
 WHEN foreign_key_violation THEN RAISE SQLSTATE 'PT400' USING MESSAGE='A referenced record no longer exists.';
END $$;
GRANT CREATE ON SCHEMA public TO dsu_placement;
ALTER FUNCTION public.dsu_placement_mutate(text,jsonb,uuid) OWNER TO dsu_placement;
REVOKE CREATE ON SCHEMA public FROM dsu_placement;
REVOKE ALL ON FUNCTION public.dsu_placement_mutate(text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dsu_placement_mutate(text,jsonb,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
