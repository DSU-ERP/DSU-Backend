import { readFile, writeFile } from 'node:fs/promises';
import { CATEGORY_RULES, CGPA_SCALE, DISTRIBUTION_BANDS, categorySql } from '../src/modules/analytics/categoryRules.js';

// Generate once for this migration. Future rule changes require a NEW migration.
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const template = await readFile(new URL('./portal-read.sql', import.meta.url), 'utf8');
const sql = template
  .replaceAll('__CATEGORY_RULES__', literal(JSON.stringify(CATEGORY_RULES)))
  .replaceAll('__CGPA_SCALE__', literal(JSON.stringify(CGPA_SCALE)))
  .replaceAll('__DISTRIBUTION_BANDS__', literal(JSON.stringify(DISTRIBUTION_BANDS)))
  .replaceAll('__CATEGORY_SQL__', categorySql('a.cgpa', literal));
const target = new URL('../supabase/migrations/003_supabase_portal_reads.sql', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== sql) throw new Error('Portal migration and shared rules disagree');
  console.log('Portal SQL matches shared CGPA definitions');
} else {
  await writeFile(target, sql);
  console.log('Generated portal read migration');
}
