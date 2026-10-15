import {readFile,writeFile} from 'node:fs/promises';
import {PLACEMENT_POLICY,placementSql} from '../src/modules/analytics/placementPolicy.js';
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
const replace=(s,from,to)=>{if(!s.includes(from))throw new Error(`Missing migration anchor: ${from}`);return s.replaceAll(from,to)};
const oldPortal=await readFile(new URL('../supabase/migrations/003_supabase_portal_reads.sql',import.meta.url),'utf8');
const oldBatch=await readFile(new URL('../supabase/migrations/004_batch_drilldown.sql',import.meta.url),'utf8');
let summary=oldPortal.slice(oldPortal.indexOf('CREATE FUNCTION erp.portal_summary'),oldPortal.indexOf('CREATE FUNCTION public.dsu_portal_read'));
summary=replace(summary,'CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
summary=replace(summary,"jsonb_build_object('configured',false)",'erp.placement_policy()');
summary=replace(summary,"'averageCgpa',c.average,'eligibleCount',NULL,'eligibilityPercentage',NULL)","'averageCgpa',c.average,'eligibleCount',c.eligible,'eligibilityPercentage',CASE WHEN c.n=0 THEN 0 ELSE 100.0*c.eligible/c.n END)");
summary=replace(summary,'SELECT count(*) AS n,avg(cgpa)::text AS average FROM cohort',"SELECT count(*) AS n,count(*) FILTER(WHERE erp.placement_eligible(cgpa) IS TRUE) AS eligible,avg(cgpa)::text AS average FROM cohort");
let batch=oldBatch.slice(oldBatch.indexOf('CREATE FUNCTION public.dsu_batch_read'),oldBatch.indexOf('REVOKE ALL ON FUNCTION erp.batch_cohort'));
let portal=oldPortal.slice(oldPortal.indexOf('CREATE FUNCTION public.dsu_portal_read'),oldPortal.indexOf('-- The function owner'));
portal=replace(portal,'CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
portal=replace(portal,'cgpa::text,category_id,rank FROM ranked','cgpa::text,category_id,rank,erp.placement_eligible(ranked.cgpa) AS placement_eligible FROM ranked');
portal=replace(portal,"'academic',academic,'contact',contact,'fees',fees)","'academic',academic,'contact',contact,'fees',fees,'placement_eligible',erp.placement_eligible((academic->>'cgpa')::numeric),'placementPolicy',erp.placement_policy())");
batch=replace(batch,'CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
batch=replace(batch,"RETURN jsonb_build_object('data',(payload->'data')||extra);","RETURN jsonb_build_object('data',(payload->'data')||extra||jsonb_build_object('placement_eligible',erp.placement_eligible((payload#>>'{data,academic,cgpa}')::numeric),'placementPolicy',erp.placement_policy()));");
batch=replace(batch,'count(*) FILTER(WHERE category_id IS NULL) AS unclassified,',"count(*) FILTER(WHERE category_id IS NULL) AS unclassified,\n   count(*) FILTER(WHERE erp.placement_eligible(cgpa) IS TRUE) AS eligible,\n   count(*) FILTER(WHERE erp.placement_eligible(cgpa) IS FALSE) AS not_eligible,");
batch=replace(batch,"'eligible',NULL,'eligibility_percentage',NULL)","'eligible',count(*) FILTER(WHERE erp.placement_eligible(cgpa) IS TRUE),\n   'not_eligible',count(*) FILTER(WHERE erp.placement_eligible(cgpa) IS FALSE),\n   'eligibility_percentage',CASE WHEN count(*)=0 THEN 0 ELSE 100.0*count(*) FILTER(WHERE erp.placement_eligible(cgpa) IS TRUE)/count(*) END)");
batch=replace(batch,"'placementConfigured',false","'placementConfigured',true,'placementPolicy',erp.placement_policy()");
batch=replace(batch,'attendance::text,current_backlog,status,category_id\n',"attendance::text,current_backlog,status,category_id,erp.placement_eligible(c.cgpa) AS placement_eligible\n");
const sql=`-- CGPA-only placement policy confirmed by the institution. Generated from placementPolicy.js.
-- Existing rows, permissions and audit policies are preserved.
CREATE FUNCTION erp.placement_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT ${quote(JSON.stringify(PLACEMENT_POLICY))}::jsonb
$$;
CREATE FUNCTION erp.placement_eligible(value numeric) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT ${placementSql('a.cgpa',quote)} FROM (SELECT value AS cgpa) a
$$;
REVOKE ALL ON FUNCTION erp.placement_policy(),erp.placement_eligible(numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION erp.placement_policy(),erp.placement_eligible(numeric) TO dsu_api;
${summary}
${portal}
${batch}
NOTIFY pgrst,'reload schema';
`;
const target=new URL('../supabase/migrations/005_placement_eligibility.sql',import.meta.url);
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==sql)throw new Error('Placement migration differs from policy');console.log('Placement migration matches policy');}
else{await writeFile(target,sql);console.log('Generated placement migration');}
