import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { withActor } from '../src/integrations/supabase/db.js';

test('batched actor settings remain local and isolated after commit and rollback', async () => {
  const db = new PGlite();
  let released = 0;
  const calls = [];
  const client = { release() { released++; }, query(sql, values) { calls.push(sql); return values || !sql.includes(';') ? db.query(sql, values) : db.exec(sql); } };
  const pool = { connect: async () => client };
  const settings = "SELECT current_setting('app.user_id',true) actor,current_setting('request.jwt.claims',true) claims";
  try {
    for (const actor of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) {
      calls.length = 0;
      await withActor(pool, actor, async c => {
        const { rows: [row] } = await c.query(settings);
        assert.equal(row.actor, actor);
        assert.deepEqual(JSON.parse(row.claims), { sub: actor, role: 'authenticated' });
      });
      assert.equal(calls.length, 3, 'one batch (begin + both settings), operation, commit');
      const { rows: [outside] } = await db.query(settings);
      assert.equal(outside.actor || null, null);
      assert.equal(outside.claims || null, null);
    }
    await assert.rejects(withActor(pool, 'rollback-actor', async c => {
      const { rows: [row] } = await c.query(settings);
      assert.equal(row.actor, 'rollback-actor');
      throw Error('synthetic failure');
    }), /synthetic failure/);
    const { rows: [outside] } = await db.query(settings);
    assert.equal(outside.actor || null, null);
    assert.equal(outside.claims || null, null);
    assert.equal(released, 3);
  } finally { await db.close(); }
});

test('a prelude query rides in the same round trip as BEGIN and its rows reach the callback', async () => {
  const db = new PGlite();
  const calls = [];
  const client = { release() {}, query(sql, values) { calls.push(sql); return values || !sql.includes(';') ? db.query(sql, values) : db.exec(sql); } };
  const pool = { connect: async () => client };
  const actor = "00000000-0000-4000-8000-00000000000a";
  try {
    const seen = await withActor(pool, actor, async (_c, rows) => rows, {
      prelude: (literal) => `SELECT current_setting('app.user_id',true) AS actor, ${literal("it's quoted")} AS text`,
    });
    assert.deepEqual(seen, [{ actor, text: "it's quoted" }]);
    assert.equal(calls.length, 2, 'one batch (begin, settings, prelude) plus commit');
  } finally { await db.close(); }
});
