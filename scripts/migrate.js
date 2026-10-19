import { createPool } from '../src/integrations/supabase/db.js';
import { migrate } from '../src/platform/database/migrations.js';
if (!process.env.DATABASE_ADMIN_URL) {
  console.error('DATABASE_ADMIN_URL is not set. Put the Supabase postgres (session pooler) URL in .env.operator.');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_ADMIN_URL);
let client, applied = 0;
try {
  client = await pool.connect();
  await migrate(client, undefined, name => { applied++; console.log('Applied ' + name); });
  console.log(applied ? `Done: ${applied} migration(s) applied. Restart the backend.` : 'Database is already up to date.');
} catch (error) {
  // Nothing is half-applied: all pending migrations run in one transaction.
  console.error(`Migration failed${error.migration ? ' in ' + error.migration : ''}: ${error.code || 'CHECK_MIGRATION'} ${String(error.message || '').replace(/\/\/[^/\s@]*@/g, '//***@').slice(0, 500)}`);
  console.error('No changes were saved. Fix the cause and run npm run db:migrate again.');
  process.exitCode = 1;
}
finally { client?.release(); await pool.end(); }
