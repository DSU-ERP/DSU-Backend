// Synthetic actors/conversations only. Every test and preview DDL is rolled back.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/integrations/supabase/db.js';
const pool = createPool(process.env.DATABASE_ADMIN_URL);
let c;
try {
  c = await pool.connect();
  await c.query('BEGIN');
  if (process.argv.includes('--preview'))
    await c.query(await readFile(new URL('../supabase/migrations/202610160001_friday_conversation_rename.sql', import.meta.url), 'utf8'));
  const owner = randomUUID(), other = randomUUID(), inactive = randomUUID();
  for (const actor of [owner, other, inactive]) {
    await c.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)", [actor, `test-${actor}@example.invalid`]);
    await c.query('INSERT INTO placement.officers(user_id,active) VALUES($1,$2)', [actor, actor !== inactive]);
  }
  const id = randomUUID(), observation = randomUUID();
  for (const [cid, assistant] of [[id, 'friday'], [observation, 'observation']])
    await c.query("INSERT INTO placement.conversations(id,owner_id,title,assistant) VALUES($1,$2,'Original',$3)", [cid, owner, assistant]);
  await c.query("INSERT INTO placement.messages(conversation_id,role,content) VALUES($1,'user','Synthetic message')", [id]);
  const asActor = async (actor) => {
    await c.query('RESET ROLE');
    await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: 'authenticated' })]);
    await c.query('SET LOCAL ROLE authenticated');
  };
  const rename = (cid, title) => c.query('SELECT public.dsu_friday_rename($1,$2) AS result', [cid, title]);
  const denied = async (fn, code) => {
    await c.query('SAVEPOINT rejection');
    let error;
    try { await fn(); } catch (e) { error = e; }
    await c.query('ROLLBACK TO SAVEPOINT rejection');
    assert.equal(error?.code, code);
  };
  await asActor(owner);
  const result = (await rename(id, '  Follow-ups  ')).rows[0].result.data;
  assert.equal(result.title, 'Follow-ups');
  for (const title of ['', '   ', 'a'.repeat(121), 'a\nb', null])
    await denied(() => rename(id, title), 'PT400');
  await denied(() => rename(observation, 'Wrong assistant'), 'PT404');
  await denied(() => rename(randomUUID(), 'Missing'), 'PT404');
  await asActor(other);
  await denied(() => rename(id, 'Not owner'), 'PT404');
  await asActor(inactive);
  await denied(() => rename(id, 'Inactive'), 'PT403');
  await asActor(owner);
  await c.query("SELECT public.dsu_placement_mutate('conversation.append',$1,$2)", [JSON.stringify({ conversation_id: id, user: 'Follow-up', assistant: 'Reply' }), randomUUID()]);
  const saved = (await c.query("SELECT public.dsu_placement_read('conversation',$1) AS result", [JSON.stringify({ id })])).rows[0].result.data;
  assert.equal(saved.title, 'Follow-ups');
  assert.equal(saved.messages.length, 3);
  await c.query('RESET ROLE');
  assert.equal((await c.query("SELECT has_function_privilege('anon','public.dsu_friday_rename(uuid,text)','EXECUTE') AS allowed")).rows[0].allowed, false);
  console.log('Rename persistence, append preservation, validation, owner isolation and authorization passed. All fixtures rolled back.');
} catch (e) {
  console.error('Rename verification failed:', e.code || e.message);
  process.exitCode = 1;
} finally {
  if (c) { await c.query('ROLLBACK'); c.release(); }
  await pool.end();
}
