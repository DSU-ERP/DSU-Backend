// Admin portal API and the officer FRIDAY trace intake
// (docs/agent-workflow-visualization). Every read goes through ops.* SQL
// functions that require an account on the dedicated ops.admins list.
import { z } from "zod";
import { sqlCall } from "../company/routes.js";
import { WORKFLOWS } from "./workflows.js";
import { safeMeta } from "./tracer.js";
import { httpError } from "../../platform/http/errors.js";

const iso = z.iso.datetime({ offset: true });
const stepSchema = z
  .object({
    seq: z.number().int().min(1).max(500),
    parent_seq: z.number().int().min(1).max(500).optional(),
    node: z.string().regex(/^[a-z][a-z0-9_.:-]{0,79}$/),
    kind: z.enum(["input", "auth", "guard", "limit", "context", "route", "retrieval", "tool", "model", "validate", "persist", "output"]),
    label: z.string().min(1).max(120),
    status: z.enum(["running", "completed", "failed", "skipped", "denied"]),
    started_at: iso,
    ended_at: iso.optional(),
    duration_ms: z.number().int().min(0).max(86400000).optional(),
    attempt: z.number().int().min(1).max(20).optional(),
    error_category: z.string().max(40).optional(),
    meta: z.record(z.string().max(40), z.union([z.string().max(60), z.number(), z.boolean()])).optional(),
  })
  .strict();

export function registerOpsRoutes(api, { pool }) {
  const call = (req, sql, values) => sqlCall(pool, req.actor.id, sql, values);

  api.get("/admin/session", async (req) => {
    await call(req, "SELECT ops.assert_admin() AS result");
    return { data: { admin: true } };
  });
  api.get("/admin/agent-workflows", async (req) => {
    await call(req, "SELECT ops.assert_admin() AS result");
    return { data: WORKFLOWS };
  });
  api.get("/admin/agent-runs", async (req) => {
    const q = z
      .object({
        assistant: z.enum(["student", "officer", "company"]).optional(),
        status: z.enum(["running", "completed", "failed", "denied"]).optional(),
        tool: z.string().regex(/^[a-z_]{1,60}$/).optional(),
        since: iso.optional(),
        until: iso.optional(),
        changedAfter: iso.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict()
      .parse(req.query);
    return { data: await call(req, "SELECT ops.agent_runs_list($1::jsonb) AS result", [JSON.stringify(q)]) };
  });
  api.get("/admin/agent-runs/:id", async (req) => ({
    data: await call(req, "SELECT ops.agent_run($1::uuid) AS result", [z.uuid().parse(req.params.id)]),
  }));

  // Officer FRIDAY runs in the web app; it reports its own run here. The
  // database records the caller's real role, and only the caller can append.
  api.post("/ops/traces", { bodyLimit: 4000 }, async (req) => {
    const body = z
      .object({ id: z.uuid(), assistant: z.literal("officer"), startedAt: iso, summary: z.record(z.string(), z.union([z.string().max(60), z.number(), z.boolean()])).optional() })
      .strict()
      .parse(req.body);
    const officer = await call(req, "SELECT student.is_officer() AS result");
    if (!officer) throw httpError(403, "FORBIDDEN", "Placement Officer access is required.");
    await call(req, "SELECT ops.trace_start($1::jsonb) AS result", [
      JSON.stringify({ id: body.id, assistant: "officer", workflow_version: "officer-friday-v1", started_at: body.startedAt, summary: body.summary || {} }),
    ]);
    return { data: { id: body.id } };
  });
  api.post("/ops/traces/:id/steps", { bodyLimit: 120000 }, async (req) => {
    const id = z.uuid().parse(req.params.id);
    const body = z
      .object({
        steps: z.array(stepSchema).max(100),
        finish: z
          .object({ status: z.enum(["completed", "failed", "denied"]), error_category: z.string().max(40).optional(),
            summary: z.record(z.string(), z.union([z.string().max(60), z.number(), z.boolean()])).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    // The same metadata allowlist as backend traces: unknown keys are dropped.
    const steps = body.steps.map((step) => ({ ...step, meta: safeMeta(step.meta) }));
    const finish = body.finish ? { ...body.finish, ...(body.finish.summary ? { summary: safeMeta(body.finish.summary) } : {}) } : null;
    await call(req, "SELECT ops.trace_steps($1::uuid,$2::jsonb,$3::jsonb) AS result", [id, JSON.stringify(steps), finish ? JSON.stringify(finish) : null]);
    return { data: { ok: true } };
  });
}
