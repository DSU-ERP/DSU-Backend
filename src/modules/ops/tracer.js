// Agent run tracing (docs/agent-workflow-visualization). A run records the
// steps F.R.I.D.A.Y. actually executed: node, kind, status, real timestamps and
// a small allowlisted metadata object. Prompts, answers, tool arguments, tool
// results and student records are never recorded.
//
// Writes are two short calls per run: one when it starts (so the Admin portal
// can show it running) and one when it ends with every step. Tracing failures
// are swallowed: a trace must never break or slow an answer noticeably.
import { randomUUID } from "node:crypto";
import { withActor } from "../../integrations/supabase/db.js";

export const WORKFLOW_VERSIONS = Object.freeze({ student: "student-friday-v1", company: "company-friday-v1", officer: "officer-friday-v1" });

// Only these metadata keys survive, and only as short strings, numbers or booleans.
const META_KEYS = new Set([
  "tool", "kind", "decision", "branch", "reason", "count", "rows", "results", "chars", "messages", "history", "detail", "drives",
  "applications", "events", "notices", "hasResume", "hasDrive", "webSearch", "provider", "model", "httpStatus", "code", "iteration",
  "toolCalls", "tokensIn", "tokensOut", "released", "candidates", "contact", "phase", "enabled", "citations", "card",
]);
export function safeMeta(meta = {}) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (!META_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 60);
  }
  return out;
}

/** Maps an error to a coarse category; messages are never recorded. */
export function errorCategory(error) {
  const code = String(error?.code || "");
  if (error?.statusCode === 403 || code === "PT403" || code === "FORBIDDEN") return "forbidden";
  if (error?.statusCode === 401 || code === "PT401") return "unauthenticated";
  if (error?.statusCode === 404 || code === "PT404" || code === "NOT_FOUND") return "not_found";
  if (error?.statusCode === 429 || /RATE|BUSY/.test(code)) return "rate_limited";
  if (/TIMEOUT/.test(code) || error?.name === "TimeoutError") return "timeout";
  if (/AI_INVALID|OUTPUT_LIMIT/.test(code)) return "invalid_model_output";
  if (/^AI_/.test(code)) return "model_provider";
  if (/^PT400|VALIDATION/.test(code) || error?.name === "ZodError") return "validation";
  if (/^PT|^[0-9A-Z]{5}$/.test(code)) return "database";
  return "internal";
}

const pending = new Set();
/** Tests wait for in-flight trace writes before reading them. */
export async function tracesSettled() {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Creates a tracer. `step(node, kind, label, fn, meta)` times fn, records
 * completed or failed (denied for 403s) and rethrows. `record()` adds a step
 * that did not run code here (skipped branches, decisions).
 */
export function createTracer(pool, { assistant, actorId, summary = {}, enabled = true }) {
  const id = randomUUID();
  const started = new Date();
  const steps = [];
  let seq = 0;
  let active = enabled && !!pool && !!actorId;
  const write = (fn) => {
    if (!active) return Promise.resolve();
    const job = withActor(pool, actorId, fn)
      .catch(() => {
        // A missing ops schema (database behind the code) or any trace failure
        // turns tracing off for this run only.
        active = false;
      })
      .finally(() => pending.delete(job));
    pending.add(job);
    return job;
  };
  const begin = write((client) =>
    client.query("SELECT ops.trace_start($1::jsonb)", [
      JSON.stringify({
        id, assistant, workflow_version: WORKFLOW_VERSIONS[assistant], started_at: started.toISOString(), summary: safeMeta(summary),
      }),
    ]),
  );
  const add = (node, kind, label, status, startedAt, endedAt, meta, extra = {}) => {
    seq += 1;
    const entry = {
      seq, node, kind, label: label.slice(0, 120), status, started_at: startedAt.toISOString(),
      ...(endedAt ? { ended_at: endedAt.toISOString(), duration_ms: Math.max(0, endedAt - startedAt) } : {}),
      meta: safeMeta(meta), ...extra,
    };
    if (seq <= 500) steps.push(entry);
    return entry;
  };
  const tracer = {
    id,
    // Await before the request's own database work so the two never overlap.
    ready: begin,
    get enabled() {
      return active;
    },
    /** Times one step. meta may be a function of the result. */
    async step(node, kind, label, fn, meta = {}, extra = {}) {
      const startedAt = new Date();
      try {
        const result = await fn();
        add(node, kind, label, "completed", startedAt, new Date(), typeof meta === "function" ? meta(result) : meta, extra);
        return result;
      } catch (error) {
        const category = errorCategory(error);
        add(node, kind, label, category === "forbidden" || category === "unauthenticated" ? "denied" : "failed", startedAt, new Date(),
          typeof meta === "function" ? {} : meta, { ...extra, error_category: category });
        throw error;
      }
    },
    /** Opens a step now (so children can point at it) and closes it later. */
    open(node, kind, label, extra = {}) {
      const startedAt = new Date();
      const entry = add(node, kind, label, "running", startedAt, null, {}, extra);
      return {
        seq: entry.seq,
        end(status, meta = {}, more = {}) {
          const endedAt = new Date();
          Object.assign(entry, { status, ended_at: endedAt.toISOString(), duration_ms: Math.max(0, endedAt - startedAt), meta: safeMeta(meta) }, more);
        },
      };
    },
    /** Records a step whose outcome is already known (a branch taken or skipped). */
    record(node, kind, label, status, meta = {}, extra = {}) {
      const now = new Date();
      return add(node, kind, label, status, now, now, meta, extra);
    },
    /** Records an externally timed step (for example a model call timed inside generate). */
    span(node, kind, label, status, startedAt, endedAt, meta = {}, extra = {}) {
      return add(node, kind, label, status, startedAt, endedAt, meta, extra);
    },
    /** Ends the run. Never throws. */
    finish(status, { error, summary } = {}) {
      const finish = { status, ...(error ? { error_category: errorCategory(error) } : {}), ...(summary ? { summary: safeMeta(summary) } : {}) };
      return begin.then(() =>
        write((client) =>
          client.query("SELECT ops.trace_steps($1::uuid,$2::jsonb,$3::jsonb)", [id, JSON.stringify(steps.slice(0, 100)), JSON.stringify(finish)]),
        ),
      );
    },
  };
  return tracer;
}

/** Runs a traced handler: finishes the run as completed, denied or failed. */
export async function traced(tracer, fn) {
  try {
    const result = await fn(tracer);
    await tracer.finish("completed");
    return result;
  } catch (error) {
    const category = errorCategory(error);
    await tracer.finish(category === "forbidden" || category === "unauthenticated" ? "denied" : "failed", { error });
    throw error;
  }
}
