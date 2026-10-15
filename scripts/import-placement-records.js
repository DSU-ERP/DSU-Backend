// Offline, operator-only ingestion of recorded results. Dry-run unless --apply is supplied.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {createPool} from '../src/integrations/supabase/db.js';
const score=z.number().finite().nonnegative(),name=z.string().trim().min(1).max(200);
const words=z.array(name).max(100).default([]),percent=z.number().finite().min(0).max(100).nullable().default(null);
const time=z.iso.datetime({offset:true});
const base={usn:name};
const result=z.object({...base,assessment_id:name,assessment_name:name,tier:z.union([z.literal(1),z.literal(2)]),score:score.max(100000),max_score:score.positive().max(100000),time_seconds:z.number().int().nonnegative().nullable().default(null),qualified_tier2:z.boolean().nullable().default(null),classification:z.enum(['Basic','Medium','Advanced']).nullable().default(null),indicators:z.record(z.string(),z.union([z.number().finite().nonnegative(),z.boolean(),z.string().max(500)])).default({}),flagged:z.boolean().default(false),auto_submitted:z.boolean().default(false),completed_at:time}).strict().refine(r=>r.score<=r.max_score);
const points=z.object({...base,academic:score.max(1000000),github:score.max(1000000),domain:score.max(1000000),breakdown:z.record(z.string(),z.union([z.number().finite(),z.string().max(500)])).default({}),updated_at:time}).strict();
const prediction=z.object({...base,readiness:z.enum(['job-ready','mid-level','entry-level']),risk:z.enum(['low','medium','high']),roles:words,domains:words,skills:words,languages:words,strengths:words,risks:words,recommendations:words,alignment:percent,practical:percent,theoretical:percent,course_fit:percent,generated_at:time}).strict();
const file=process.argv[2];
if(!file || file.startsWith('--'))throw new Error('Usage: node --env-file-if-exists=.env scripts/import-placement-records.js <recorded-data.json> [--apply]');
const raw=await readFile(file);if(raw.length>20_000_000)throw new Error('Input exceeds 20 MB. Split the source into smaller files.');
const parsed=z.object({tests:z.array(result).max(20000).default([]),points:z.array(points).max(20000).default([]),predictions:z.array(prediction).max(20000).default([])}).strict().safeParse(JSON.parse(raw));
if(!parsed.success){console.error('Invalid source fields:',parsed.error.issues.map(i=>i.path.join('.')).join(', '));process.exit(1);}
const pool=createPool(process.env.DATABASE_ADMIN_URL),client=await pool.connect();
try {
  await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('placement.recorded-import'))");
  const index=new Map((await client.query('SELECT id,enrollment_no FROM erp.students')).rows.map(s=>[s.enrollment_no,s.id]));
  const seen=new Set();let count=0;
  for(const [kind,records] of Object.entries(parsed.data))for(const [position,record] of records.entries()){
    const {usn,...values}=record,id=index.get(usn);if(!id)throw new Error(`Unmatched student in ${kind} at row ${position+1}. No changes saved.`);
    const identity=`${kind}:${id}:${record.assessment_id??''}:${record.tier??''}`;
    if(seen.has(identity))throw new Error(`Duplicate ${kind} identity at row ${position+1}.`);seen.add(identity);
    const table={tests:'test_results',points:'points',predictions:'predictions'}[kind];
    const columns=['student_id',...Object.keys(values)]; // z.strict() restricts every identifier above.
    const args=[id,...Object.entries(values).map(([key,v])=>['indicators','breakdown'].includes(key)?JSON.stringify(v):v)];
    const conflict=kind==='tests'?'student_id,assessment_id,tier':'student_id';
    const timestamp=kind==='tests'?'completed_at':kind==='points'?'updated_at':'generated_at';
    await client.query(`INSERT INTO placement.${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT(${conflict}) DO UPDATE SET ${columns.slice(1).map(k=>`${k}=excluded.${k}`).join(',')} WHERE excluded.${timestamp}>=placement.${table}.${timestamp}`,args);count++;
  }
  const apply=process.argv.includes('--apply');
  if(apply)await client.query("INSERT INTO placement.events(actor_id,action,details) VALUES('00000000-0000-0000-0000-000000000000','operator.recorded-import',$1)",[{records:count,sha256:createHash('sha256').update(raw).digest('hex')}]);
  await client.query(apply?'COMMIT':'ROLLBACK');console.log(JSON.stringify({valid:true,records:count,saved:apply}));
}catch(e){await client.query('ROLLBACK');console.error('Import failed:',e.code||e.message);process.exitCode=1;}finally{client.release();await pool.end();}
