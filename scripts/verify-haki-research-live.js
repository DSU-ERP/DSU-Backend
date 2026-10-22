// Live provider/search integration using synthetic chat and an in-memory SQL
// stand-in. No real account, database read or student message is created.
import assert from 'node:assert/strict';
import { createResearch } from '../src/modules/research/index.js';
import { createStudentAI } from '../src/modules/students/ai.js';
import { registerChatRoutes } from '../src/modules/students/chat.js';
if (!process.argv.includes('--live')) throw Error('Pass --live to use the configured search and AI providers.');
const id = '00000000-0000-4000-8000-000000000001';
let stored = null;
const client = { release() {}, async query(sql, values) {
  if (sql.includes('FROM erp.memberships')) return { rows: [{ id, course_name: 'B.Tech', department_name: 'Computer Science', cgpa: '8' }] };
  if (sql.includes('SELECT * FROM student.conversations')) return { rows: [{ id, context: {} }] };
  if (sql.includes('count(*)')) return { rows: [{ n: 0, running: 0 }] };
  if (sql.startsWith('INSERT INTO student.ai_requests')) return { rows: [{ id }] };
  if (sql.startsWith('INSERT INTO student.messages')) stored = { text: values[3], sources: JSON.parse(values[5]) };
  return { rows: [] };
} };
const pool = { connect: async () => client }, research = createResearch();
const generate = createStudentAI(pool, process.env);
const routes = new Map(), api = { get() {}, post: (path, handler) => routes.set(path, handler) };
registerChatRoutes(api, { pool, research, generate });
const started = performance.now();
try {
  assert.equal(research.enabled, true, 'search must be configured');
  const { data } = await routes.get('/student/conversations/:id/message')({ actor: { id }, params: { id }, body: { message: 'Where can I check current graduate engineering jobs at Infosys in India? Search the web and cite relevant official pages. Distinguish careers portals from verified individual vacancies.', webSearch: true } });
  assert.equal(data.research, 'used');assert.ok(data.researchInfo.resultCount > 0);assert.ok(data.sources.length > 0, 'answer cites supplied search results');assert.equal(stored.text, data.text);
  assert.doesNotMatch(data.text, /I (?:have no|do not have|don't have) (?:live|real.time|web|internet) (?:access|feed)/i);
  console.log(JSON.stringify({ passed: true, ms: Math.round(performance.now()-started), research: data.research, results: data.researchInfo.resultCount, citations: data.sources.map(s=>s.domain), text: data.text, storage: 'in-memory stand-in only' }));
} catch(error) { console.error(JSON.stringify({passed:false,code:error.code||'CHECK_FAILED',ms:Math.round(performance.now()-started)}));process.exitCode=1; }
finally { await research.close(); }
