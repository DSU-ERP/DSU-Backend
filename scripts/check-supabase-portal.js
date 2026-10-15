import assert from 'node:assert/strict';
import { createPool, withActor } from '../src/integrations/supabase/db.js';
import { analyticsSummary } from '../src/modules/analytics/studentAnalytics.js';

const owner = createPool(process.env.DATABASE_ADMIN_URL);
const runtime = createPool(process.env.DATABASE_URL);
try {
  const {rows} = await owner.query("SELECT user_id FROM erp.memberships WHERE role='admin' ORDER BY created_at LIMIT 1");
  if (!rows[0]) throw new Error('No administrator configured');
  const actor = rows[0].user_id;
  const expected = await withActor(runtime,actor,c=>analyticsSummary(c,{}));
  const client = await owner.connect();
  let actual;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,role:'authenticated'})]);
    await client.query('SET LOCAL ROLE authenticated');
    actual = (await client.query("SELECT public.dsu_portal_read('/analytics') AS result")).rows[0].result.data.summary;
    assert.deepEqual(actual,expected);
    await client.query('ROLLBACK'); // Do not retain verification audit records.
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/dsu_portal_read`,{
    method:'POST', headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({request_path:'/analytics',query:{}}),signal:AbortSignal.timeout(15000),
  });
  assert.equal(response.status,401);
  const body = await response.json();
  assert.equal(body.code,'42501'); // Registered RPC denied to anonymous role, not a missing endpoint.
  console.log(JSON.stringify({supabaseRpcRegistered:true,anonymousDenied:true,oldAndNewAnalyticsMatch:true,
    students:actual.total,valid:actual.valid,unclassified:actual.unclassified,
    categories:actual.categories.map(c=>({id:c.id,count:c.count}))}));
} catch(error) { console.error('Supabase portal check failed:',error.code,error.message); process.exitCode=1; }
finally { await owner.end(); await runtime.end(); }
