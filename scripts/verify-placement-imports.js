// All verification records and preview schema changes are rolled back.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {createPool} from '../src/integrations/supabase/db.js';
import {HEADERS} from '../src/modules/imports/csv.js';
import {importStudents} from '../src/modules/imports/importer.js';

const pool=createPool(process.env.DATABASE_ADMIN_URL);
let c;
let stage='setup';
try {
  c=await pool.connect();
  await c.query('BEGIN');
  if(process.argv.includes('--preview'))
    await c.query(await readFile(new URL('../supabase/migrations/202610150001_placement_imports.sql',import.meta.url),'utf8'));
  const actors=Object.fromEntries(['officer','inactive','staff','admin','unlinked'].map(role=>[role,randomUUID()]));
  for(const [role,id] of Object.entries(actors)) {
    await c.query('INSERT INTO auth.users(id,aud,role,email) VALUES($1,$2,$3,$4)',[id,'authenticated','authenticated',`test-${id}@example.invalid`]);
    if(role==='officer'||role==='inactive')
      await c.query('INSERT INTO placement.officers(user_id,active) VALUES($1,$2)',[id,role==='officer']);
    if(role==='staff'||role==='admin')
      await c.query('INSERT INTO erp.memberships(user_id,role) VALUES($1,$2)',[id,role]);
  }
  const makeCsv=(cgpa='8.499')=>HEADERS.join(',')+'\n'+HEADERS.map(h=>({
    enrollmentNo:`TEST-${actors.officer}`,studentFullName:'Synthetic Import Verification',cgpa,
  }[h]??'')).join(',');
  const denied=async(fn,code)=>{
    await c.query('SAVEPOINT denied_check');
    let failure;
    try{await fn();}catch(e){failure=e;}
    await c.query('ROLLBACK TO SAVEPOINT denied_check');
    await c.query('RELEASE SAVEPOINT denied_check');
    assert.equal(failure?.code,code);
  };
  for(const [role,id] of Object.entries(actors)) {
    stage=`database import role: ${role}`;
    await c.query('RESET ROLE');
    await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.student_import','false',true)",[id]);
    await c.query('SET LOCAL ROLE dsu_api');
    const allowed=(await c.query('SELECT erp.can_import_students() AS allowed')).rows[0].allowed;
    assert.equal(allowed,role==='officer'||role==='admin');
    if(role==='officer')
      await denied(()=>importStudents(c,Readable.from([makeCsv()]),'2099',id),'42501');
    await c.query("SELECT set_config('app.student_import','true',true)");
    if(allowed) {
      const summary=await importStudents(c,Readable.from([makeCsv(role==='admin'?'8.75':'8.499')]),'2099',id);
      assert.equal(summary.inserted+summary.updated,1);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM erp.import_runs WHERE actor_id=$1',[id])).rows[0].n,1);
      // Officers can write an audit record without gaining audit-table read access.
      await c.query('RESET ROLE');
      assert.equal((await c.query('SELECT count(*)::int AS n FROM erp.audit_events WHERE actor_id=$1',[id])).rows[0].n,1);
    } else {
      await denied(()=>importStudents(c,Readable.from([makeCsv()]),'2099',id),'42501');
    }
  }
  for(const [role,id] of Object.entries(actors)) {
    stage=`history RPC role: ${role}`;
    await c.query('RESET ROLE');
    await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})]);
    await c.query('SET LOCAL ROLE authenticated');
    if(role==='officer') {
      const result=(await c.query('SELECT public.dsu_placement_imports() AS result')).rows[0].result;
      assert.ok(Array.isArray(result.data));
      assert.ok(result.data.some(r=>r.source_batch==='2099'));
    } else await denied(()=>c.query('SELECT public.dsu_placement_imports()'),'PT403');
  }
  await c.query('RESET ROLE');
  assert.equal((await c.query("SELECT has_function_privilege('anon','public.dsu_placement_imports()','EXECUTE') AS allowed")).rows[0].allowed,false);
  await c.query('ROLLBACK');
  console.log('PASS: officer/admin import, update, audit, restricted context, inactive/staff/unlinked denial, JWT history and anonymous denial. All verification rows rolled back.');
}catch(e){
  if(c) await c.query('ROLLBACK');
  console.error('Import verification failed:',stage,e.code||e.name,e.code==='ERR_ASSERTION'?e.message:'');
  process.exitCode=1;
}finally{c?.release();await pool.end();}
