import {createPool} from '../src/integrations/supabase/db.js';
import {assertTestingTarget,assertTestingMarker} from '../src/platform/testing-guard.js';
assertTestingTarget();
const pool=createPool(process.env.TESTING_DATABASE_ADMIN_URL,{...process.env,DATABASE_CA_PATH:process.env.TESTING_DATABASE_CA_PATH,DATABASE_POOL_MAX:'1'});
try {
 const c=await pool.connect();
 try {await assertTestingMarker(c);
 console.log(JSON.stringify({project:process.env.TESTING_SUPABASE_PROJECT_REF,accounts:(await c.query(`SELECT u.email, m.role, (m.student_id IS NOT NULL) AS student_linked, COALESCE(o.active,false) AS officer FROM auth.users u LEFT JOIN erp.memberships m ON m.user_id=u.id LEFT JOIN placement.officers o ON o.user_id=u.id ORDER BY u.email LIMIT 30`)).rows},null,2));
 } finally{c.release();}
} finally {await pool.end();}
