// Ranking recalculation. Runs only in the sync worker (app.sync_worker='on'):
// new evidence queues a student (ranking.request_recalculation from the sync
// result writer), a nightly pass and model changes queue everyone, and each
// worker tick drains a bounded batch. Page loads never calculate.
import { createHash } from "node:crypto";
import { workerTransaction } from "../intelligence/sync.js";
import { evaluateStudent } from "./engine.js";

export const BATCH = 200;
export const HISTORY_KEPT = 20;

export async function currentModel(client) {
  const { rows } = await client.query("SELECT config FROM ranking.models WHERE current");
  return rows[0]?.config ?? null;
}

/** Hash of everything an officer sees, so history records only real changes. */
export const resultHash = (r) =>
  createHash("sha256")
    .update(JSON.stringify([r.academic, r.dsa, r.github, r.developer, r.coverage, r.evidenceState, r.topics]))
    .digest("hex");

/**
 * Recalculates the given students inside an existing worker transaction.
 * Returns {students, changed, failed}. A student whose inputs cannot be
 * evaluated keeps the previous score and is reported in `failed`.
 */
export async function recalculate(client, ids, model, now = Date.now(), log) {
  if (!ids.length) return { students: 0, changed: 0, failed: [] };
  const inputs = (await client.query("SELECT ranking.calculation_inputs($1::uuid[]) AS inputs", [ids])).rows[0].inputs;
  const results = [];
  const failed = [];
  for (const input of inputs) {
    try {
      const r = evaluateStudent(input, model, now);
      results.push({ ...r, resultHash: resultHash(r) });
    } catch (error) {
      failed.push(input.id);
      log?.({ event: "ranking_student_failed", code: error?.code || "RANKING_FAILED" });
    }
  }
  if (!results.length) return { students: 0, changed: 0, failed };
  const previous = new Map(
    (
      await client.query("SELECT student_id,result_hash FROM ranking.scores WHERE model_version=$1 AND student_id=ANY($2::uuid[])", [
        model.version,
        results.map((r) => r.studentId),
      ])
    ).rows.map((row) => [row.student_id, row.result_hash]),
  );
  const rows = results.map((r) => ({
    student_id: r.studentId,
    academic: r.academic.score,
    dsa: r.dsa.score,
    github: r.github.score,
    developer: r.developer.score,
    academic_status: r.academic.status,
    dsa_status: r.dsa.status,
    github_status: r.github.status,
    developer_status: r.developer.status,
    coverage: r.coverage,
    evidence_state: r.evidenceState,
    explanation: { academic: r.academic, dsa: r.dsa, github: r.github, developer: r.developer },
    evidence_synced_at: r.evidenceSyncedAt,
    input_hash: r.inputHash,
    result_hash: r.resultHash,
  }));
  await client.query(
    `INSERT INTO ranking.scores(student_id,model_version,academic,dsa,github,developer,academic_status,dsa_status,github_status,
       developer_status,coverage,evidence_state,explanation,evidence_synced_at,input_hash,result_hash,calculated_at)
     SELECT r.student_id,$1,r.academic,r.dsa,r.github,r.developer,r.academic_status,r.dsa_status,r.github_status,r.developer_status,
       r.coverage,r.evidence_state,r.explanation,r.evidence_synced_at,r.input_hash,r.result_hash,now()
     FROM jsonb_to_recordset($2::jsonb) AS r(student_id uuid,academic numeric,dsa numeric,github numeric,developer numeric,
       academic_status text,dsa_status text,github_status text,developer_status text,coverage numeric,evidence_state text,
       explanation jsonb,evidence_synced_at timestamptz,input_hash text,result_hash text)
     ON CONFLICT(student_id,model_version) DO UPDATE SET academic=EXCLUDED.academic,dsa=EXCLUDED.dsa,github=EXCLUDED.github,
       developer=EXCLUDED.developer,academic_status=EXCLUDED.academic_status,dsa_status=EXCLUDED.dsa_status,
       github_status=EXCLUDED.github_status,developer_status=EXCLUDED.developer_status,coverage=EXCLUDED.coverage,
       evidence_state=EXCLUDED.evidence_state,explanation=EXCLUDED.explanation,evidence_synced_at=EXCLUDED.evidence_synced_at,
       input_hash=EXCLUDED.input_hash,result_hash=EXCLUDED.result_hash,calculated_at=now()`,
    [model.version, JSON.stringify(rows)],
  );
  const studentIds = results.map((r) => r.studentId);
  await client.query("DELETE FROM ranking.topic_scores WHERE model_version=$1 AND student_id=ANY($2::uuid[])", [model.version, studentIds]);
  const topics = results.flatMap((r) => r.topics.map((t) => ({ student_id: r.studentId, topic_code: t.code, source: t.source, score: t.score, stale: t.stale, evidence: t.evidence })));
  if (topics.length)
    await client.query(
      `INSERT INTO ranking.topic_scores(student_id,model_version,topic_code,source,score,stale,evidence)
       SELECT t.student_id,$1,t.topic_code,t.source,t.score,t.stale,t.evidence
       FROM jsonb_to_recordset($2::jsonb) AS t(student_id uuid,topic_code text,source text,score numeric,stale boolean,evidence jsonb)`,
      [model.version, JSON.stringify(topics)],
    );
  const changed = results.filter((r) => previous.get(r.studentId) !== r.resultHash);
  if (changed.length) {
    await client.query(
      `INSERT INTO ranking.score_history(student_id,model_version,input_hash,snapshot,calculated_at)
       SELECT h.student_id,$1,h.input_hash,h.snapshot,now() FROM jsonb_to_recordset($2::jsonb) AS h(student_id uuid,input_hash text,snapshot jsonb)`,
      [model.version, JSON.stringify(changed.map((r) => ({ student_id: r.studentId, input_hash: r.inputHash, snapshot: { ...r, resultHash: r.resultHash } })))],
    );
    await client.query(
      `DELETE FROM ranking.score_history h WHERE h.student_id=ANY($1::uuid[]) AND h.id NOT IN
         (SELECT k.id FROM ranking.score_history k WHERE k.student_id=h.student_id ORDER BY k.calculated_at DESC,k.id DESC LIMIT ${HISTORY_KEPT})`,
      [changed.map((r) => r.studentId)],
    );
  }
  return { students: results.length, changed: changed.length, failed };
}

/** Drains one bounded batch of the recalculation queue. Returns the number of students processed. */
export async function drainQueue(pool, { limit = BATCH, now = Date.now, log } = {}) {
  return workerTransaction(pool, async (client) => {
    const model = await currentModel(client);
    if (!model) return 0;
    const ids = (
      await client.query(
        `DELETE FROM ranking.queue WHERE student_id IN
           (SELECT student_id FROM ranking.queue ORDER BY queued_at,student_id LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING student_id`,
        [limit],
      )
    ).rows.map((r) => r.student_id);
    if (!ids.length) return 0;
    const outcome = await recalculate(client, ids, model, now(), log);
    await client.query(
      "INSERT INTO ranking.runs(model_version,kind,students,changed,finished_at) VALUES($1,'batch',$2,$3,now())",
      [model.version, outcome.students, outcome.changed],
    );
    if (outcome.changed || outcome.failed.length)
      log?.({ event: "ranking_batch", students: outcome.students, changed: outcome.changed, failed: outcome.failed.length });
    return ids.length;
  });
}

/** Queues every student when the current model has had no full pass within `hours`. */
export async function requestFullRecalculation(pool, hours = 24) {
  return workerTransaction(pool, async (client) =>
    (await client.query("SELECT ranking.request_full_recalculation(make_interval(hours=>$1)) AS n", [hours])).rows[0]?.n ?? 0,
  );
}
