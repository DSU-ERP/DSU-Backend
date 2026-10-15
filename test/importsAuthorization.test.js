import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { HEADERS } from '../src/modules/imports/csv.js';

const actor = '11111111-1111-4111-8111-111111111111';
const env = { SERVICE_TOKEN: 'x'.repeat(64) };
const headers = { authorization: 'Bearer test', 'x-service-token': env.SERVICE_TOKEN };
const csv = HEADERS.join(',') + '\n' + HEADERS.map(h => ({
  enrollmentNo: 'TEST-IMPORT-001', studentFullName: 'Synthetic Import', cgpa: '8.499',
}[h] ?? '')).join(',');

function fixture(allowed) {
  const queries = [];
  const client = {
    release() {},
    async query(sql, args) {
      queries.push({sql,args});
      if (sql.includes('can_import_students')) return { rows: [{ allowed }] };
      if (sql.startsWith('INSERT INTO erp.students'))
        return { rows: [{id:actor,enrollment_no:'TEST-IMPORT-001',inserted:true}] };
      if (sql.startsWith('INSERT INTO erp.import_runs')) return { rows: [{id:actor}] };
      return { rows: [] };
    },
  };
  return { queries, pool: { connect: async () => client, end: async () => {} }, verify: async () => ({id:actor}) };
}

test('active import authorization works without a Campus portal membership and records the actor', async t => {
  for (const prefix of ['/api/v1', '/v1']) {
    const f = fixture(true);
    const app = await buildApp({...f,env,logger:false});
    t.after(() => app.close());
    assert.equal((await app.inject({url:prefix+'/imports',headers})).statusCode,200);
    const res = await app.inject({method:'POST',url:prefix+'/imports?batch=2028',headers:{...headers,'content-type':'text/csv'},payload:csv});
    assert.equal(res.statusCode,200, res.body);
    assert.equal(res.json().data.inserted,1);
    assert.ok(f.queries.some(q => q.sql.includes("set_config('app.student_import', 'true', true)")));
    assert.ok(f.queries.some(q => q.sql.includes('INSERT INTO erp.audit_events') && q.args[0]===actor));
    assert.ok(!f.queries.some(q => q.sql.includes('SELECT role, student_id')));
  }
});

test('inactive or unassigned users cannot read import history or write records', async t => {
  for (const prefix of ['/api/v1', '/v1']) {
    const f = fixture(false);
    const app = await buildApp({...f,env,logger:false});
    t.after(() => app.close());
    assert.equal((await app.inject({url:prefix+'/imports',headers})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:prefix+'/imports?batch=2028',headers:{...headers,'content-type':'text/csv'},payload:csv})).statusCode,403);
    assert.ok(!f.queries.some(q => q.sql.includes('INSERT INTO') || q.sql.includes('FROM erp.import_runs')));
    assert.ok(f.queries.some(q => q.sql==='ROLLBACK'));
  }
});

test('authorized malformed imports roll back instead of saving a partial batch', async t => {
  const f = fixture(true);
  const app = await buildApp({...f,env,logger:false});
  t.after(() => app.close());
  const res = await app.inject({method:'POST',url:'/api/v1/imports?batch=2028',headers:{...headers,'content-type':'text/csv'},payload:'invalid,columns\n1,2'});
  assert.equal(res.statusCode,400);
  assert.ok(f.queries.some(q=>q.sql==='ROLLBACK'));
  assert.ok(!f.queries.some(q=>q.sql.startsWith('INSERT INTO')));
});
