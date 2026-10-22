import { createPool } from '../src/integrations/supabase/db.js';
import { schemaStatus } from '../src/platform/database/readiness.js';
import { responseSchema } from '../src/modules/students/chat.js';
import { studentProviderRouting } from '../src/modules/students/ai.js';
import { z } from 'zod';
const pool = createPool(process.env.DATABASE_URL);
try { console.log('database', JSON.stringify(await schemaStatus(pool))); }
catch (error) { console.log('database', error.code || error.name); }
finally { await pool.end(); }
try {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(40000),
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.STUDENT_AI_MODEL || process.env.OPENROUTER_MODEL,
      provider: studentProviderRouting(process.env.OPENROUTER_PROVIDER), max_tokens: 256,
      messages: [{role:'user',content:'Connection check. Return a brief greeting in text, null card and an empty citations array.'}],
      response_format: {type:'json_schema',json_schema:{name:'student_result',strict:true,schema:z.toJSONSchema(responseSchema)}} }),
  });
  const data = await response.json();
  console.log('provider', JSON.stringify({status:response.status, error:data.error ? {code:data.error.code,message:data.error.message,provider:data.error.metadata?.provider_name} : undefined, valid: response.ok ? responseSchema.safeParse(JSON.parse(data.choices?.[0]?.message?.content || '{}')).success : false, finish:data.choices?.[0]?.finish_reason}));
} catch(error) { console.log('provider',error.name,error.message); }
