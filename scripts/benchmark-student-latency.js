// Explicit, read-only network check: synthetic interview text, no student data
// or saved AI records. Run with Node's --env-file=.env and --live to opt in.
import { performance } from 'node:perf_hooks';
import { createPool, withActor } from '../src/integrations/supabase/db.js';
import { createStudentAI } from '../src/modules/students/ai.js';
import { feedbackSchema } from '../src/modules/students/interviews.js';
import { INTERVIEW_EVALUATION_TASK } from '../src/modules/students/interview-prompts.js';

if (!process.argv.includes('--live')) throw Error('Pass --live to measure the configured database and AI provider.');
const actor = '00000000-0000-4000-8000-000000000001';
const pool = createPool(process.env.DATABASE_URL);
try {
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    await withActor(pool, actor, c => c.query('SELECT 1 AS synthetic_probe'));
    console.log(JSON.stringify({ stage: 'actor-transaction', sample: i, ms: Math.round(performance.now() - start) }));
  }
} finally { await pool.end(); }
if (!process.argv.includes('--ai')) process.exit(0);
const input = {
  question: { question: 'How did you debug a failing test in your academic project?', focus: 'Problem solving', expectedPoints: ['Reproduce the issue', 'Isolate the cause', 'Verify the fix'], isFollowUp: false, parentQuestion: null, parentAnswer: null },
  answer: 'In my campus portal project, a test failed when a student had no submissions. I reproduced it with an empty fixture, traced the failure to an undefined value, added a default empty list and regression tests, and verified that the test suite passed.',
  role: 'Graduate software engineer', company: '', goal: 'Academic project and debugging practice', jd: '', resume: '',
  config: { language: 'en-IN', tone: 'friendly', depth: 'moderate', keywords: [] },
};
const client = { release() {}, async query(sql) {
  if (sql.includes('FROM erp.memberships')) return { rows: [{ id: 'synthetic' }] };
  if (sql.includes('count(*)::int n')) return { rows: [{ n: 0, running: 0 }] };
  if (sql.startsWith('INSERT INTO student.ai_requests')) return { rows: [{ id: 'synthetic' }] };
  return { rows: [] };
} };
for (const effort of ['default', 'low']) {
  let usage, provider;
  const generate = createStudentAI({ connect: async () => client }, process.env, undefined, { request: async (url, options) => {
    const body = JSON.parse(options.body);
    if (effort === 'low') body.reasoning = { effort: 'low', exclude: true };
    else delete body.reasoning;
    const response = await fetch(url, { ...options, body: JSON.stringify(body) });
    if (response.ok) { const data = await response.clone().json(); usage = data.usage; provider = data.provider; }
    return response;
  } });
  const start = performance.now();
  try {
    const result = await generate(actor, 'interview.evaluate', INTERVIEW_EVALUATION_TASK, input, feedbackSchema);
    console.log(JSON.stringify({ stage: 'synthetic-evaluation', effort, ms: Math.round(performance.now() - start), valid: true, turn: result.turn.kind, overall: result.scores.overall, provider, completionTokens: usage?.completion_tokens, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens }));
  } catch (error) {
    console.log(JSON.stringify({ stage: 'synthetic-evaluation', effort, ms: Math.round(performance.now() - start), valid: false, code: error.code || 'FAILED' }));
  }
}
