-- Department summaries, sortable student cohorts, and lazy detail expansion.
-- Uses the existing private tables, row policies, and exact CGPA classifier.
CREATE FUNCTION erp.batch_cohort(q jsonb)
RETURNS TABLE(id uuid,enrollment_no text,full_name text,department_short_name text,
 source_batch text,current_semester text,current_batch text,admission_quota text,
 gender text,cgpa numeric,sgpa numeric,attendance numeric,current_backlog integer,
 status text,category_id text)
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT s.id,s.enrollment_no,s.full_name,s.department_short_name,s.source_batch,
 s.current_semester,s.current_batch,s.admission_quota,
 CASE upper(c.details->>'gender') WHEN 'M' THEN 'Male' WHEN 'MALE' THEN 'Male'
 WHEN 'F' THEN 'Female' WHEN 'FEMALE' THEN 'Female' ELSE NULLIF(c.details->>'gender','') END,
 a.cgpa,a.sgpa,a.attendance,a.current_backlog,s.status,erp.cgpa_category(a.cgpa)
 FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
 LEFT JOIN erp.contacts c ON c.student_id=s.id AND erp.actor_role()='admin'
 WHERE s.source_batch=q->>'batch'
 AND (NULLIF(q->>'department','') IS NULL OR s.department_short_name=q->>'department'
   OR (q->>'department'='__missing__' AND s.department_short_name IS NULL))
 AND (NULLIF(q->>'quota','') IS NULL OR s.admission_quota=q->>'quota'
   OR (q->>'quota'='__missing__' AND s.admission_quota IS NULL))
 AND (NULLIF(q->>'category','') IS NULL OR erp.cgpa_category(a.cgpa)=q->>'category'
   OR (q->>'category'='unclassified' AND erp.cgpa_category(a.cgpa) IS NULL))
 AND (COALESCE(q->>'search','')='' OR strpos(lower(s.full_name),lower(q->>'search'))>0
   OR strpos(lower(s.enrollment_no),lower(q->>'search'))>0)
$$;

CREATE FUNCTION public.dsu_batch_read(request_path text,query jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE
 actor uuid := (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
 member_role text;
 selected_id uuid;
 selected_batch text;
 summary jsonb;
 departments jsonb;
 options jsonb;
 payload jsonb;
 extra jsonb;
 students jsonb;
 total_count integer;
 page_no integer;
 page_size integer;
 order_column text;
 order_direction text;
 is_export boolean := right(request_path,7)='/export';
BEGIN
 IF actor IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='Sign in to continue.'; END IF;
 PERFORM set_config('app.user_id',actor::text,true);
 SELECT m.role INTO member_role FROM erp.memberships m WHERE m.user_id=actor;
 IF member_role IS NULL OR member_role NOT IN ('admin','staff') THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied.'; END IF;
 IF query IS NULL OR jsonb_typeof(query)<>'object' OR octet_length(query::text)>4096
 OR EXISTS(SELECT 1 FROM jsonb_each(query) p WHERE p.key NOT IN ('batch','department','quota','category','search','page','limit','sort','direction') OR jsonb_typeof(p.value)<>'string')
 OR (query ? 'batch' AND query->>'batch' !~ '^20[0-9]{2}$')
 OR (query ? 'department' AND length(query->>'department') NOT BETWEEN 1 AND 200)
 OR (query ? 'quota' AND length(query->>'quota') NOT BETWEEN 1 AND 200)
 OR length(COALESCE(query->>'search',''))>100
 OR (query ? 'category' AND query->>'category' NOT IN ('advanced','medium','needs-improvement','unclassified'))
 OR (query ? 'page' AND query->>'page' !~ '^[0-9]{1,6}$')
 OR (query ? 'limit' AND query->>'limit' !~ '^[0-9]{1,3}$')
 OR (query ? 'sort' AND query->>'sort' NOT IN ('cgpa','name','usn','sgpa','attendance','backlogs','semester'))
 OR (query ? 'direction' AND query->>'direction' NOT IN ('asc','desc')) THEN
   RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid filters.';
 END IF;
 page_no := COALESCE((query->>'page')::integer,1);
 page_size := COALESCE((query->>'limit')::integer,25);
 IF page_no NOT BETWEEN 1 AND 100000 OR page_size NOT BETWEEN 1 AND 100 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='Invalid pagination.'; END IF;
 selected_batch := COALESCE(query->>'batch',(SELECT min(s.source_batch) FROM erp.students s));
 query := query || jsonb_build_object('batch',selected_batch);
 IF request_path ~ '^/batches/student/[0-9a-fA-F-]{36}$' THEN
   BEGIN selected_id := split_part(request_path,'/',4)::uuid;
   EXCEPTION WHEN invalid_text_representation THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Student not found.'; END;
   IF NOT EXISTS(SELECT 1 FROM erp.batch_cohort(query) c WHERE c.id=selected_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Student not found in this cohort.'; END IF;
   payload := public.dsu_portal_read('/students/'||selected_id::text);
   SELECT jsonb_build_object('admission_year',s.admission_year,'admission_academic_year',s.admission_academic_year,
     'admission_type',s.admission_type,'admission_quota',s.admission_quota,'exam_semester',s.exam_semester,
     'course_short_name',s.course_short_name,'department_short_name',s.department_short_name)
   INTO extra FROM erp.students s WHERE s.id=selected_id;
   RETURN jsonb_build_object('data',(payload->'data')||extra);
 END IF;
 IF request_path NOT IN ('/batches','/batches/students','/batches/export') THEN RAISE SQLSTATE 'PT404' USING MESSAGE='Resource not found.'; END IF;
 IF is_export AND member_role<>'admin' THEN RAISE SQLSTATE 'PT403' USING MESSAGE='Access denied.'; END IF;
 SELECT jsonb_build_object('batches',ARRAY(SELECT DISTINCT source_batch FROM erp.students ORDER BY source_batch),
   'departments',ARRAY(SELECT DISTINCT department_short_name FROM erp.students WHERE source_batch=selected_batch AND department_short_name IS NOT NULL ORDER BY department_short_name),
   'missing_department',EXISTS(SELECT 1 FROM erp.students WHERE source_batch=selected_batch AND department_short_name IS NULL),
   'quotas',ARRAY(SELECT DISTINCT admission_quota FROM erp.students WHERE source_batch=selected_batch AND admission_quota IS NOT NULL ORDER BY admission_quota),
   'missing_quota',EXISTS(SELECT 1 FROM erp.students WHERE source_batch=selected_batch AND admission_quota IS NULL)) INTO options;
 WITH cohort AS MATERIALIZED (SELECT * FROM erp.batch_cohort(query)),
 groups AS (SELECT c.department_short_name,count(*) AS total,
   CASE WHEN member_role='admin' THEN count(*) FILTER(WHERE gender='Male') END AS male,
   CASE WHEN member_role='admin' THEN count(*) FILTER(WHERE gender='Female') END AS female,
   CASE WHEN member_role='admin' THEN count(*) FILTER(WHERE gender IS NULL OR gender NOT IN ('Male','Female')) END AS gender_other,
   count(*) FILTER(WHERE category_id IS NOT NULL AND cgpa>=6) AS at_least_six,
   count(*) FILTER(WHERE category_id IS NOT NULL AND cgpa<6) AS below_six,
   count(*) FILTER(WHERE category_id IS NULL) AS unclassified,
   (avg(cgpa) FILTER(WHERE category_id IS NOT NULL))::text AS average_cgpa,
   (SELECT jsonb_object_agg(k.quota,k.n) FROM (SELECT COALESCE(d.admission_quota,'__missing__') AS quota,count(*) AS n
     FROM cohort d WHERE d.department_short_name IS NOT DISTINCT FROM c.department_short_name GROUP BY 1) k) AS quotas
   FROM cohort c GROUP BY c.department_short_name)
 SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.total DESC,g.department_short_name),'[]'::jsonb) INTO departments FROM groups g;
 SELECT jsonb_build_object('total',count(*),'valid',count(*) FILTER(WHERE category_id IS NOT NULL),
   'unclassified',count(*) FILTER(WHERE category_id IS NULL),
   'male',CASE WHEN member_role='admin' THEN count(*) FILTER(WHERE gender='Male') END,
   'female',CASE WHEN member_role='admin' THEN count(*) FILTER(WHERE gender='Female') END,
   'gender_other',CASE WHEN member_role='admin' THEN count(*) FILTER(WHERE gender IS NULL OR gender NOT IN ('Male','Female')) END,
   'at_least_six',count(*) FILTER(WHERE category_id IS NOT NULL AND cgpa>=6),
   'below_six',count(*) FILTER(WHERE category_id IS NOT NULL AND cgpa<6),
   'average_cgpa',(avg(cgpa) FILTER(WHERE category_id IS NOT NULL))::text,
   'eligible',NULL,'eligibility_percentage',NULL) INTO summary FROM erp.batch_cohort(query);
 total_count := (summary->>'total')::integer;
 page_no := least(page_no,greatest(1,ceil(total_count::numeric/page_size)::integer));
 payload := jsonb_build_object('batch',selected_batch,'summary',summary,'departments',departments,'options',options,
   'categories',erp.cgpa_rules(),'genderAvailable',member_role='admin','placementConfigured',false);
 IF request_path<>'/batches' THEN
   IF is_export THEN
     IF total_count>20000 THEN RAISE SQLSTATE 'PT413' USING MESSAGE='Narrow the selection to 20,000 students.'; END IF;
     PERFORM pg_advisory_xact_lock(hashtext('erp.portal.export'),hashtext(actor::text));
     IF (SELECT count(*) FROM erp.audit_events WHERE actor_id=actor AND action='category.export' AND created_at>now()-interval '1 minute')>=5 THEN
       RAISE SQLSTATE 'PT429' USING MESSAGE='Please wait before exporting again.';
     END IF;
   END IF;
   -- Only fixed SQL expressions can enter ORDER BY; every filter remains a bound value.
   order_column := CASE COALESCE(query->>'sort','cgpa') WHEN 'name' THEN 'lower(full_name) COLLATE "C"'
     WHEN 'usn' THEN 'enrollment_no COLLATE "C"' WHEN 'sgpa' THEN 'sgpa' WHEN 'attendance' THEN 'attendance'
     WHEN 'backlogs' THEN 'current_backlog' WHEN 'semester' THEN 'CASE WHEN current_semester ~ ''^[0-9]+$'' THEN current_semester::numeric END' ELSE 'cgpa' END;
   order_direction := CASE WHEN query->>'direction'='asc' THEN 'ASC' ELSE 'DESC' END;
   EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM (
     SELECT id,enrollment_no,full_name,department_short_name,source_batch,current_semester,current_batch,
       admission_quota,gender,cgpa::text,sgpa::text,attendance::text,current_backlog,status,category_id
     FROM erp.batch_cohort($1) c ORDER BY %s %s NULLS LAST,enrollment_no COLLATE "C",id LIMIT $2 OFFSET $3) r',
     -- Qualify numeric keys so SELECT text aliases never change numeric sorting.
     CASE WHEN order_column IN ('cgpa','sgpa','attendance','current_backlog') THEN 'c.'||order_column ELSE order_column END,order_direction)
   INTO students USING query,CASE WHEN is_export THEN 20000 ELSE page_size END,CASE WHEN is_export THEN 0 ELSE (page_no-1)*page_size END;
   payload := payload || jsonb_build_object('students',students,'pagination',jsonb_build_object('total',total_count,'page',page_no,'limit',page_size));
 END IF;
 INSERT INTO erp.audit_events(actor_id,action,resource_id) VALUES(actor,CASE WHEN is_export THEN 'category.export' ELSE 'batch.read' END,request_path);
 RETURN jsonb_build_object('data',payload);
END $$;
REVOKE ALL ON FUNCTION erp.batch_cohort(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION erp.batch_cohort(jsonb) TO dsu_api;
GRANT CREATE ON SCHEMA public TO dsu_api;
ALTER FUNCTION public.dsu_batch_read(text,jsonb) OWNER TO dsu_api;
REVOKE CREATE ON SCHEMA public FROM dsu_api;
REVOKE ALL ON FUNCTION public.dsu_batch_read(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dsu_batch_read(text,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
