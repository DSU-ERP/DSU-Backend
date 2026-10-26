import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPool} from '../src/integrations/supabase/db.js';
import {assertTestingTarget,assertTestingMarker,TESTING_PROJECT_REF} from '../src/platform/testing-guard.js';
import {checksumMatches} from '../src/platform/database/migrations.js';
import {seedCatalogs,seedFixtures} from '../src/modules/competency/data/seed.js';

assertTestingTarget();
const apply=process.argv.includes('--apply');
const pool=createPool(process.env.TESTING_DATABASE_ADMIN_URL,{...process.env,DATABASE_CA_PATH:process.env.TESTING_DATABASE_CA_PATH,DATABASE_POOL_MAX:'1',DATABASE_STATEMENT_TIMEOUT_MS:'120000',DATABASE_QUERY_TIMEOUT_MS:'120000'});
export async function canonicalFingerprint(c){
 const result={};
 for(const table of ['students','academics','contacts']) result[table]=(await c.query(`SELECT count(*)::int AS count,md5(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text)) AS hash FROM erp.${table} t`)).rows[0];
 result.offers=(await c.query(`SELECT count(*)::int AS count,md5(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text)) AS hash FROM placement.offers t`)).rows[0];
 return result;
}
try{
 const c=await pool.connect();
 try{
  await assertTestingMarker(c);
  const before=await canonicalFingerprint(c);
  if(before.students.count!==100)throw new Error('Existing canonical cohort is not exactly 100 students');
  if(!apply){console.log(JSON.stringify({project:TESTING_PROJECT_REF,mode:'read-only',canonical:before,next:'Pass --apply to install competency testing schema and fixtures.'},null,2));}
  else{
   await c.query('BEGIN');
   try{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('competency.testing.install'))");
    await assertTestingMarker(c);
    for(const name of ['002_competency_intelligence.sql','003_competency_evidence_guards.sql']) {
    const sql=await readFile(new URL('../supabase/testing-migrations/'+name,import.meta.url),'utf8');
    const previous=(await c.query('SELECT checksum FROM testing.schema_migrations WHERE name=$1',[name])).rows[0];
    if(previous && !checksumMatches(sql,previous.checksum))throw new Error('Applied competency migration checksum differs');
    if(!previous){await c.query(sql);await c.query('INSERT INTO testing.schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
    }
    const catalog=await seedCatalogs(c),fixtures=await seedFixtures(c,catalog);
    const after=await canonicalFingerprint(c);
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Canonical student or placement data changed; rolling back');
    await c.query('COMMIT');
    const report={project:TESTING_PROJECT_REF,appliedAt:new Date().toISOString(),competencies:catalog.competencies.length,roles:catalog.roles.length,templates:catalog.templates.length,fixtures,canonicalUnchanged:true,canonical:after,productionAccessed:false,renderChanged:false};
    await mkdir(new URL('../.local/',import.meta.url),{recursive:true});
    await writeFile(new URL('../.local/competency-testing-install.json',import.meta.url),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
   }catch(e){await c.query('ROLLBACK');throw e;}
  }
 }finally{c.release();}
}catch(e){console.error(JSON.stringify({error:e.code??'TESTING_INSTALL_FAILED',message:e.message}));process.exitCode=1;}finally{await pool.end();}
