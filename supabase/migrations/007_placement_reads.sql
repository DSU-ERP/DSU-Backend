CREATE FUNCTION placement.report(q jsonb) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 WITH students AS MATERIALIZED(SELECT * FROM placement.cohort(q)),
 offers AS MATERIALIZED(SELECT * FROM placement.offer_facts(jsonb_build_object('inactive','false')||q)),
 drives AS MATERIALIZED(SELECT * FROM placement.drives d WHERE nullif(q->>'batch','') IS NULL OR d.batch=q->>'batch'),
 departments AS(SELECT s.department,count(*) total FROM students s GROUP BY s.department),
 department_rows AS(SELECT d.*,
   count(o.id) AS offers,count(DISTINCT o.student_id) AS placed,count(o.id) FILTER(WHERE o.status='accepted') AS accepted,
   round(100.0*count(DISTINCT o.student_id)/nullif(d.total,0),2) AS placement_percentage,
   round(count(o.id)::numeric/nullif(d.total,0),2) AS offers_per_student,
   round(100.0*count(o.id) FILTER(WHERE o.status='accepted')/nullif(count(o.id),0),2) AS acceptance_percentage,
   min(o.package_lpa) AS minimum,max(o.package_lpa) AS highest,avg(o.package_lpa) AS average,
   percentile_cont(0.5) WITHIN GROUP(ORDER BY o.package_lpa) AS median,
   percentile_cont(0.75) WITHIN GROUP(ORDER BY o.package_lpa) AS p75,
   percentile_cont(0.90) WITHIN GROUP(ORDER BY o.package_lpa) AS p90,
   count(o.id) FILTER(WHERE placement.package_rank(o.package_lpa)>=2) AS dream_and_above,
   round(100.0*count(o.id) FILTER(WHERE placement.package_rank(o.package_lpa)>=2)/nullif(count(o.id),0),2) AS dream_share,
   (SELECT f.company FROM offers f WHERE f.department IS NOT DISTINCT FROM d.department GROUP BY f.company ORDER BY count(*) DESC,f.company LIMIT 1) AS leading_company
 FROM departments d LEFT JOIN offers o ON o.department IS NOT DISTINCT FROM d.department GROUP BY d.department,d.total),
 company_rows AS(SELECT c.id,c.name,c.industry,c.active,
   (SELECT count(*) FROM drives d WHERE d.company_id=c.id) AS drives,
   (SELECT count(*) FROM placement.registrations r JOIN drives d ON d.id=r.drive_id JOIN students s ON s.id=r.student_id WHERE d.company_id=c.id) AS registered,
   (SELECT count(*) FROM placement.registrations r JOIN drives d ON d.id=r.drive_id JOIN students s ON s.id=r.student_id WHERE d.company_id=c.id AND r.status IN ('selected','placed')) AS selected,
   count(o.id) AS offers,count(DISTINCT o.student_id) AS hired,count(o.id) FILTER(WHERE o.status='accepted') AS accepted,
   avg(o.package_lpa) AS average,max(o.package_lpa) AS highest,
   count(o.id) FILTER(WHERE o.category='regular') AS regular,count(o.id) FILTER(WHERE o.category='dream') AS dream,
   count(o.id) FILTER(WHERE o.category='super-dream') AS super_dream,count(o.id) FILTER(WHERE o.category='mega') AS mega
 FROM placement.companies c LEFT JOIN offers o ON o.company_id=c.id GROUP BY c.id)
 SELECT jsonb_build_object(
 'summary',jsonb_build_object('students',(SELECT count(*) FROM students),'placed',(SELECT count(DISTINCT student_id) FROM offers),
 'unplaced',(SELECT count(*) FROM students)-(SELECT count(DISTINCT student_id) FROM offers),
 'placement_percentage',coalesce((SELECT round(100.0*count(DISTINCT student_id)/nullif((SELECT count(*) FROM students),0),2) FROM offers),0),
 'offers',(SELECT count(*) FROM offers),'accepted',(SELECT count(*) FROM offers WHERE status='accepted'),
 'average',(SELECT avg(package_lpa) FROM offers),'highest',(SELECT max(package_lpa) FROM offers),
 'median',(SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY package_lpa) FROM offers),
 'drives',(SELECT count(*) FROM drives),'companies',(SELECT count(DISTINCT company_id) FROM drives)),
 'departments',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY placement_percentage DESC NULLS LAST,department) FROM department_rows d),'[]'),
 'companies',coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('selection_percentage',round(100.0*c.selected/nullif(c.registered,0),2),
 'acceptance_percentage',round(100.0*c.accepted/nullif(c.offers,0),2)) ORDER BY offers DESC,name) FROM company_rows c),'[]'),
 'categories',(SELECT jsonb_agg(jsonb_build_object('category',v.category,'offers',(SELECT count(*) FROM offers o WHERE o.category=v.category))) FROM unnest(ARRAY['regular','dream','super-dream','mega']) v(category)),
 'drive_statuses',(SELECT jsonb_agg(jsonb_build_object('status',v.status,'count',(SELECT count(*) FROM drives d WHERE d.status=v.status))) FROM unnest(ARRAY['upcoming','ongoing','completed','cancelled']) v(status)),
 'recent',coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM(SELECT * FROM offers ORDER BY created_at DESC,id LIMIT 8)o),'[]'),
 'scheduled',coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM(SELECT d.*,c.name company FROM drives d JOIN placement.companies c ON c.id=d.company_id WHERE d.status IN ('upcoming','ongoing') ORDER BY d.drive_date NULLS LAST,d.id LIMIT 10)d),'[]'))
$$;

CREATE FUNCTION public.dsu_placement_read(resource text,query jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE actor uuid; q jsonb:=query; payload jsonb; rows_json jsonb; extra jsonb:='{}'; opts jsonb;
 n integer:=0; page_no integer; size integer; off integer; sort_key text; direction text; target uuid; selected placement.drives; exporting boolean;
BEGIN
 actor:=placement.assert_officer();
 IF q IS NULL OR jsonb_typeof(q)<>'object' OR octet_length(q::text)>8000
 OR EXISTS(SELECT 1 FROM jsonb_each(q) e WHERE e.key NOT IN ('batch','department','search','quota','category','eligibility','page','limit','sort','direction','id','status','package','industry','active','inactive','pool','round','readiness','risk','language','missing','classification','violation','assistant','export','company','minimum') OR jsonb_typeof(e.value)<>'string')
 OR (q ? 'batch' AND q->>'batch' !~ '^20[0-9]{2}$') OR length(coalesce(q->>'search',''))>100
 OR (q ? 'minimum' AND q->>'minimum' !~ '^(10(\.0+)?|[0-9](\.[0-9]+)?)$')
 OR (q ? 'page' AND q->>'page' !~ '^[1-9][0-9]{0,5}$') OR (q ? 'limit' AND q->>'limit' !~ '^[1-9][0-9]{0,4}$')
 OR (q ? 'id' AND q->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.'; END IF;
 IF resource='session' THEN RETURN jsonb_build_object('data',jsonb_build_object('id',actor,'role','placement_officer')); END IF;
 exporting:=q->>'export'='true';
 IF exporting AND resource NOT IN ('batch','students','ranking','offers','talent') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='This report cannot be exported.'; END IF;
 IF exporting THEN
   PERFORM pg_advisory_xact_lock(hashtext('placement.export'),hashtext(actor::text));
   IF (SELECT count(*) FROM placement.events WHERE actor_id=actor AND action='export' AND created_at>now()-interval '1 minute')>=5 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='Please wait before exporting again.'; END IF;
 END IF;
 page_no:=coalesce((q->>'page')::integer,1); size:=CASE WHEN exporting THEN 20000 ELSE least(coalesce((q->>'limit')::integer,25),100) END;
 off:=(page_no-1)*size; target:=(q->>'id')::uuid;
 SELECT jsonb_build_object('batches',ARRAY(SELECT DISTINCT source_batch FROM erp.students ORDER BY source_batch DESC),
 'departments',ARRAY(SELECT DISTINCT coalesce(department_short_name,'__missing__') FROM erp.students ORDER BY 1),
 'quotas',ARRAY(SELECT DISTINCT coalesce(admission_quota,'__missing__') FROM erp.students ORDER BY 1),
 'industries',ARRAY(SELECT DISTINCT industry FROM placement.companies WHERE industry IS NOT NULL ORDER BY industry),
 'policy',erp.placement_policy(),'categories',erp.cgpa_rules()) INTO opts;

 CASE resource
 WHEN 'overview','company-reports','departments' THEN
   payload:=placement.report(CASE WHEN resource='company-reports' THEN q-'search' ELSE q END); RETURN jsonb_build_object('data',payload||jsonb_build_object('options',opts));
 WHEN 'companies' THEN
   WITH companies AS(SELECT c.*,(SELECT count(*) FROM placement.drives d WHERE d.company_id=c.id) drives,
     (SELECT count(*) FROM placement.offers o JOIN placement.registrations r ON r.id=o.registration_id JOIN placement.drives d ON d.id=r.drive_id WHERE d.company_id=c.id) offers
     FROM placement.companies c WHERE (nullif(q->>'search','') IS NULL OR strpos(lower(c.name),lower(q->>'search'))>0)
     AND (nullif(q->>'industry','') IS NULL OR c.industry=q->>'industry')
     AND (nullif(q->>'active','') IS NULL OR c.active=(q->>'active')::boolean))
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM(SELECT * FROM companies ORDER BY name,id LIMIT size OFFSET off)c),'[]') INTO n,rows_json FROM companies;
 WHEN 'company' THEN
   SELECT to_jsonb(c) INTO payload FROM placement.companies c WHERE id=target;
   IF payload IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Company not found.'; END IF;
   RETURN jsonb_build_object('data',payload||jsonb_build_object('options',opts));
 WHEN 'drives' THEN
   WITH drives AS(SELECT d.*,c.name company,placement.package_category(d.package_lpa) category,
    (SELECT count(*) FROM placement.registrations r WHERE r.drive_id=d.id) registered,
    (SELECT count(*) FROM placement.registrations r WHERE r.drive_id=d.id AND r.status IN ('selected','placed')) selected
    FROM placement.drives d JOIN placement.companies c ON c.id=d.company_id
    WHERE (nullif(q->>'batch','') IS NULL OR d.batch=q->>'batch')
    AND (nullif(q->>'company','') IS NULL OR d.company_id::text=q->>'company')
    AND (nullif(q->>'search','') IS NULL OR strpos(lower(c.name||' '||d.title),lower(q->>'search'))>0)
    AND (nullif(q->>'status','') IS NULL OR d.status=q->>'status')
    AND (nullif(q->>'package','') IS NULL OR placement.package_category(d.package_lpa)=q->>'package'))
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM(SELECT * FROM drives ORDER BY drive_date DESC NULLS LAST,id LIMIT size OFFSET off)d),'[]') INTO n,rows_json FROM drives;
 WHEN 'drive' THEN
   SELECT * INTO selected FROM placement.drives WHERE id=target;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Drive not found.'; END IF;
   SELECT jsonb_build_object('drive',to_jsonb(selected),'company',(SELECT name FROM placement.companies WHERE id=selected.company_id),
    'counts',jsonb_build_object('eligible',(SELECT count(*) FROM placement.candidates(target) WHERE eligible IS TRUE),
    'invited',(SELECT count(*) FROM placement.interests WHERE drive_id=target AND state='invited'),
    'interested',(SELECT count(*) FROM placement.interests WHERE drive_id=target AND state='interested'),
    'not-interested',(SELECT count(*) FROM placement.interests WHERE drive_id=target AND state='not-interested'),
    'registered',(SELECT count(*) FROM placement.registrations WHERE drive_id=target),
    'selected',(SELECT count(*) FROM placement.registrations WHERE drive_id=target AND status IN ('selected','placed')))) INTO extra;
   WITH candidates AS(SELECT c.*,r.status,r.current_round,r.revision,
    coalesce((SELECT jsonb_agg(to_jsonb(rr) ORDER BY round_number) FROM placement.round_results rr WHERE rr.registration_id=r.id),'[]') results
    FROM placement.candidates(target) c LEFT JOIN placement.registrations r ON r.id=c.registration_id
    WHERE (nullif(q->>'search','') IS NULL OR strpos(lower(c.name||' '||c.usn),lower(q->>'search'))>0)
    AND (nullif(q->>'pool','') IS NULL OR CASE q->>'pool' WHEN 'eligible' THEN c.eligible IS TRUE AND c.registration_id IS NULL
      WHEN 'blocked' THEN c.eligible IS NOT TRUE WHEN 'registered' THEN c.registration_id IS NOT NULL
      WHEN 'selected' THEN r.status IN ('selected','placed') ELSE c.interest=q->>'pool' END)
    AND (nullif(q->>'round','') IS NULL OR r.current_round=(q->>'round')::integer))
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('cgpa',c.cgpa::text)) FROM(SELECT * FROM candidates ORDER BY name,usn LIMIT size OFFSET off)c),'[]') INTO n,rows_json FROM candidates;
 WHEN 'offers' THEN
   WITH offers AS(SELECT * FROM placement.offer_facts(q))
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM(SELECT * FROM offers ORDER BY created_at DESC,id LIMIT size OFFSET off)o),'[]') INTO n,rows_json FROM offers;
 WHEN 'multiple-offers' THEN
   WITH groups AS(SELECT student_id,usn,name,department,count(*) offers,max(package_lpa) highest,
    max(package_lpa) FILTER(WHERE active) current_package,jsonb_agg(to_jsonb(o) ORDER BY package_lpa DESC,id) history
    FROM placement.offer_facts((q-'status'-'package')||jsonb_build_object('inactive','true')) o GROUP BY student_id,usn,name,department HAVING count(*)>=2)
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(g)||jsonb_build_object('current_category',placement.package_category(g.current_package))) FROM(SELECT * FROM groups ORDER BY offers DESC,usn LIMIT size OFFSET off)g),'[]'),
    jsonb_build_object('summary',jsonb_build_object('students',count(*),'maximum_offers',max(offers),'average_offers',avg(offers))) INTO n,rows_json,extra FROM groups;
 WHEN 'students','ranking' THEN
   sort_key:=coalesce(q->>'sort','cgpa'); direction:=coalesce(q->>'direction','desc');
   IF sort_key NOT IN ('cgpa','name','usn','sgpa','backlogs','attendance') OR direction NOT IN ('asc','desc') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid sorting.'; END IF;
   SELECT count(*) INTO n FROM placement.cohort(q);
   EXECUTE format('WITH ranked AS(SELECT c.*,CASE WHEN c.category IS NOT NULL THEN rank() OVER(ORDER BY CASE WHEN c.category IS NOT NULL THEN c.cgpa END DESC NULLS LAST) END college_rank,
    CASE WHEN c.category IS NOT NULL THEN rank() OVER(PARTITION BY c.department ORDER BY CASE WHEN c.category IS NOT NULL THEN c.cgpa END DESC NULLS LAST) END department_rank
    FROM placement.cohort($1-''department''-''search''-''category''-''quota''-''eligibility''-''minimum'') c),
    filtered AS(SELECT ranked.* FROM ranked JOIN placement.cohort($1) c USING(id))
    SELECT coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object(''cgpa'',s.cgpa::text,''sgpa'',s.sgpa::text)),''[]'')
    FROM(SELECT * FROM filtered ORDER BY %I %s NULLS LAST,usn COLLATE "C",id LIMIT $2 OFFSET $3)s',sort_key,direction)
    INTO rows_json USING q,size,off;
 WHEN 'batch' THEN
   WITH cohort AS MATERIALIZED(SELECT * FROM placement.cohort(q)), departments AS(SELECT department,count(*) total,
    count(*) FILTER(WHERE gender IN ('M','Male')) male,count(*) FILTER(WHERE gender IN ('F','Female')) female,
    count(*) FILTER(WHERE gender IS NULL OR gender NOT IN ('M','Male','F','Female')) other_gender,
    count(*) FILTER(WHERE upper(quota) IN ('DSAT','DSAT ONLINE')) dsat,count(*) FILTER(WHERE upper(quota)='CET') cet,
    count(*) FILTER(WHERE upper(quota)='COMEDK') comedk,count(*) FILTER(WHERE upper(quota)='UNIGAUGE') unigauge,
    count(*) FILTER(WHERE upper(quota)='DCET') dcet,count(*) FILTER(WHERE upper(quota) IN ('MGMT','MANAGEMENT','MANAGEMENT QUOTA')) management,
    count(*) FILTER(WHERE quota IS NULL OR upper(quota) NOT IN ('DSAT','DSAT ONLINE','CET','COMEDK','UNIGAUGE','DCET','MGMT','MANAGEMENT','MANAGEMENT QUOTA')) other_quota,
    count(*) FILTER(WHERE category IS NOT NULL AND cgpa>=6) at_least_six,count(*) FILTER(WHERE category IS NOT NULL AND cgpa<6) below_six,
    count(*) FILTER(WHERE category IS NULL) unclassified,count(*) FILTER(WHERE eligible IS TRUE) eligible,count(*) FILTER(WHERE eligible IS FALSE) not_eligible,
    avg(cgpa) FILTER(WHERE category IS NOT NULL) average FROM cohort GROUP BY department)
   SELECT coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY department) FROM departments d),'[]'),
    jsonb_build_object('summary',jsonb_build_object('students',count(*),'valid',count(*) FILTER(WHERE category IS NOT NULL),'unclassified',count(*) FILTER(WHERE category IS NULL),
    'average',avg(cgpa) FILTER(WHERE category IS NOT NULL),'eligible',count(*) FILTER(WHERE eligible IS TRUE)),
    'categories',(SELECT jsonb_agg(r.rule||jsonb_build_object('count',s.total,'average',s.average,'eligible',s.eligible,'percentage',100.0*s.total/nullif((SELECT count(*) FROM cohort),0)))
    FROM jsonb_array_elements(erp.cgpa_rules()) r(rule) CROSS JOIN LATERAL(SELECT count(*) total,avg(cgpa) average,count(*) FILTER(WHERE eligible IS TRUE) eligible FROM cohort WHERE category=r.rule->>'id') s),
    'distribution',(SELECT jsonb_agg(to_jsonb(b)) FROM(SELECT CASE WHEN cgpa<6 THEN 'Below 6' WHEN cgpa<7 THEN '6–7' WHEN cgpa<8 THEN '7–8' WHEN cgpa<9 THEN '8–9' ELSE '9–10' END band,count(*) total FROM cohort WHERE category IS NOT NULL GROUP BY 1 ORDER BY 1)b))
    INTO rows_json,extra FROM cohort;
   n:=jsonb_array_length(rows_json);
 WHEN 'student' THEN
   SELECT to_jsonb(s)||jsonb_build_object('cgpa',s.cgpa::text,'sgpa',s.sgpa::text,'academic',(SELECT to_jsonb(a)-'fees_paid'-'fees_outstanding'-'fee_category' FROM erp.academics a WHERE a.student_id=s.id),
    'profile',(SELECT to_jsonb(p)-'source_hash' FROM erp.students p WHERE p.id=s.id),'contact',(SELECT details FROM erp.contacts c WHERE c.student_id=s.id),
    'offers',coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at DESC) FROM placement.offer_facts('{}') o WHERE o.student_id=s.id),'[]'),
    'registrations',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('drive',d.title,'company',c.name,'rounds',d.rounds,'results',
      coalesce((SELECT jsonb_agg(to_jsonb(rr) ORDER BY round_number) FROM placement.round_results rr WHERE rr.registration_id=r.id),'[]')) ORDER BY r.created_at DESC)
      FROM placement.registrations r JOIN placement.drives d ON d.id=r.drive_id JOIN placement.companies c ON c.id=d.company_id WHERE r.student_id=s.id),'[]'),
    'timeline',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM(SELECT action,details,created_at FROM placement.events WHERE student_id=s.id ORDER BY created_at DESC,id DESC LIMIT 200)e),'[]'),
    'points',(SELECT to_jsonb(p) FROM placement.points p WHERE p.student_id=s.id),'prediction',(SELECT to_jsonb(p) FROM placement.predictions p WHERE p.student_id=s.id))
    INTO payload FROM placement.cohort('{}') s WHERE s.id=target;
   IF payload IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Student not found.'; END IF;
   RETURN jsonb_build_object('data',payload);
 WHEN 'points','github','domain' THEN
   WITH scores AS(SELECT s.*,p.academic,p.github,p.domain,p.academic+p.github+p.domain total_points,p.breakdown,p.updated_at,
     rank() OVER(ORDER BY CASE resource WHEN 'github' THEN p.github WHEN 'domain' THEN p.domain ELSE p.academic+p.github+p.domain END DESC) rank
     FROM placement.points p JOIN placement.cohort(q) s ON s.id=p.student_id)
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('cgpa',s.cgpa::text)) FROM(SELECT * FROM scores ORDER BY rank,usn LIMIT size OFFSET off)s),'[]') INTO n,rows_json FROM scores;
 WHEN 'tests' THEN
   WITH latest AS(SELECT DISTINCT ON(student_id,tier) * FROM placement.test_results ORDER BY student_id,tier,completed_at DESC,id),
   results AS(SELECT s.id,s.usn,s.name,s.department,s.batch,c.details->>'email' email,
    sum(t.score) combined_score,sum(t.max_score) maximum_score,100.0*sum(t.score)/nullif(sum(t.max_score),0) percentage,
    sum(t.time_seconds) time_seconds,bool_or(t.qualified_tier2) qualified_tier2,bool_or(t.flagged) flagged,bool_or(t.auto_submitted) auto_submitted,
    (array_agg(t.classification ORDER BY t.tier DESC,t.completed_at DESC))[1] classification,jsonb_agg(to_jsonb(t) ORDER BY t.tier,t.completed_at DESC) attempts
    FROM latest t JOIN placement.cohort(q-'search') s ON s.id=t.student_id LEFT JOIN erp.contacts c ON c.student_id=s.id
    WHERE nullif(q->>'search','') IS NULL OR strpos(lower(s.name||' '||s.usn||' '||coalesce(c.details->>'email','')),lower(q->>'search'))>0
    GROUP BY s.id,s.usn,s.name,s.department,s.batch,c.details),
   filtered AS(SELECT *,rank() OVER(ORDER BY combined_score DESC) rank FROM results WHERE (nullif(q->>'classification','') IS NULL OR classification=q->>'classification')
    AND (nullif(q->>'violation','') IS NULL OR CASE q->>'violation' WHEN 'flagged' THEN flagged WHEN 'auto-submitted' THEN auto_submitted ELSE NOT flagged END))
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM(SELECT * FROM filtered ORDER BY rank,usn LIMIT size OFFSET off)r),'[]'),
    jsonb_build_object('summary',jsonb_build_object('participants',count(*),'average_score',avg(combined_score),'average_percentage',avg(percentage),'flagged',count(*) FILTER(WHERE flagged),'auto_submitted',count(*) FILTER(WHERE auto_submitted))) INTO n,rows_json,extra FROM filtered;
 WHEN 'talent' THEN
   sort_key:=coalesce(q->>'sort','points'); direction:=coalesce(q->>'direction','desc');
   IF sort_key NOT IN ('points','cgpa','alignment','name') OR direction NOT IN ('asc','desc') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid sorting.'; END IF;
   WITH profiles AS(SELECT s.*,p.student_id prediction_id,p.readiness,p.risk,p.roles,p.domains,p.skills,p.languages,p.strengths,p.risks,p.recommendations,p.alignment,p.practical,p.theoretical,p.course_fit,p.generated_at,
    pt.academic+pt.github+pt.domain points FROM placement.cohort(q-'search') s LEFT JOIN placement.predictions p ON p.student_id=s.id LEFT JOIN placement.points pt ON pt.student_id=s.id),
   filtered AS(SELECT * FROM profiles p WHERE (nullif(q->>'search','') IS NULL OR strpos(lower(p.name||' '||p.usn||' '||coalesce(array_to_string(p.roles||p.domains||p.skills,' '),'')),lower(q->>'search'))>0)
    AND (nullif(q->>'readiness','') IS NULL OR p.readiness=q->>'readiness') AND (nullif(q->>'risk','') IS NULL OR p.risk=q->>'risk')
    AND (nullif(q->>'language','') IS NULL OR q->>'language'=ANY(p.languages)) AND (coalesce(q->>'missing','false')<>'true' OR p.prediction_id IS NULL))
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('cgpa',r.cgpa::text)) FROM(SELECT * FROM filtered
    ORDER BY CASE WHEN direction='desc' THEN CASE sort_key WHEN 'points' THEN points WHEN 'cgpa' THEN cgpa WHEN 'alignment' THEN alignment END END DESC NULLS LAST,
    CASE WHEN direction='asc' THEN CASE sort_key WHEN 'points' THEN points WHEN 'cgpa' THEN cgpa WHEN 'alignment' THEN alignment END END ASC NULLS LAST,
    CASE WHEN sort_key='name' AND direction='desc' THEN name END DESC,CASE WHEN sort_key='name' AND direction='asc' THEN name END ASC,usn LIMIT size OFFSET off)r),'[]'),
    jsonb_build_object('summary',jsonb_build_object('students',count(*),'predictions',count(prediction_id),'missing',count(*) FILTER(WHERE prediction_id IS NULL),'high_risk',count(*) FILTER(WHERE risk='high')),
    'readiness',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM(SELECT readiness,count(*) total FROM filtered WHERE readiness IS NOT NULL GROUP BY readiness)x),
    'roles',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM(SELECT role,count(*) total FROM filtered,unnest(roles) role GROUP BY role ORDER BY total DESC LIMIT 20)x),
    'languages',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM(SELECT language,count(*) total FROM filtered,unnest(languages) language GROUP BY language ORDER BY total DESC)x)) INTO n,rows_json,extra FROM filtered;
 WHEN 'conversations' THEN
   SELECT count(*),coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM(SELECT * FROM placement.conversations WHERE assistant=coalesce(q->>'assistant','observation') ORDER BY updated_at DESC,id LIMIT size OFFSET off)c),'[]') INTO n,rows_json FROM placement.conversations WHERE assistant=coalesce(q->>'assistant','observation');
 WHEN 'conversation' THEN
   SELECT to_jsonb(c)||jsonb_build_object('messages',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM(SELECT id,role,content,created_at FROM placement.messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 100)m),'[]')) INTO payload FROM placement.conversations c WHERE id=target;
   IF payload IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Conversation not found.'; END IF;
   RETURN jsonb_build_object('data',payload);
 ELSE RAISE SQLSTATE 'PT404' USING MESSAGE='Report not found.';
 END CASE;
 IF exporting THEN
   IF n>20000 THEN RAISE SQLSTATE 'PT413' USING MESSAGE='Narrow the report to at most 20,000 rows.'; END IF;
   INSERT INTO placement.events(actor_id,action,details) VALUES(actor,'export',jsonb_build_object('resource',resource,'rows',n));
 END IF;
 RETURN jsonb_build_object('data',extra||jsonb_build_object('rows',coalesce(rows_json,'[]'),'options',opts,'pagination',jsonb_build_object('total',n,'page',page_no,'limit',size)));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA placement FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA placement TO dsu_placement;
GRANT CREATE ON SCHEMA public TO dsu_placement;
ALTER FUNCTION public.dsu_placement_read(text,jsonb) OWNER TO dsu_placement;
REVOKE CREATE ON SCHEMA public FROM dsu_placement;
REVOKE ALL ON FUNCTION public.dsu_placement_read(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dsu_placement_read(text,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
