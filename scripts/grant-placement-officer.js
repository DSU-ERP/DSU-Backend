import {createPool} from '../src/integrations/supabase/db.js';
const email=process.argv[2];
if(!email||!email.includes('@'))throw new Error('Provide the existing Supabase Auth email.');
const pool=createPool(process.env.DATABASE_ADMIN_URL),client=await pool.connect();
try {
 await client.query('BEGIN');
 const users=await client.query('SELECT id FROM auth.users WHERE lower(email)=lower($1) AND deleted_at IS NULL',[email]);
 if(users.rowCount!==1)throw new Error('Exactly one existing, active Auth account is required.');
 await client.query('INSERT INTO placement.officers(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET active=true',[users.rows[0].id]);
 await client.query("INSERT INTO placement.events(actor_id,action,resource_id) VALUES($1,'operator.officer-grant',$1)",[users.rows[0].id]);
 await client.query('COMMIT');console.log('Placement Officer access granted. Existing campus roles retained.');
}catch(e){await client.query('ROLLBACK');console.error('Grant failed:',e.code||e.message);process.exitCode=1;}finally{client.release();await pool.end();}
