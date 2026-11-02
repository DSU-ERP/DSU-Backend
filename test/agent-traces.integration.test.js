import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { companySetup, EXTRACTION } from "./helpers/company.js";
import { tracesSettled } from "../src/modules/ops/tracer.js";
import { WORKFLOWS, declaredNodes } from "../src/modules/ops/workflows.js";

const SECRET_QUESTION = "Which drives am I eligible for and what does Zxqv-private-marker mean?";

async function setup() {
  const control = { fail: false };
  const ctx = await companySetup({
    studentAi: (call) => {
      if (control.fail) throw Object.assign(new Error("provider down"), { statusCode: 503, code: "AI_UNAVAILABLE" });
      if (call.kind === "company.drive.parse") return EXTRACTION;
      if (call.kind === "company.chat") return { text: "Your drive is live." };
      return { text: "You have one open drive.", card: null, citations: [] };
    },
  });
  // A dedicated admin account; it holds no student, officer or company role.
  await ctx.db.query("INSERT INTO ops.admins(user_id) VALUES($1)", [ctx.users.stranger]);
  for (const [key, email, who] of [["A", "hr@acme.test", "hrA"], ["B", "talent@beta.test", "hrB"]]) {
    const invite = await ctx.ok("POST", `/placement/companies/${ctx.companies[key]}/invites`, "officer", { email });
    await ctx.ok("POST", "/company/invites/accept", who, { token: invite.token });
  }
  const latest = async () => {
    await tracesSettled();
    return (await ctx.ok("GET", "/admin/agent-runs", "stranger")).rows[0];
  };
  const run = async (id) => {
    await tracesSettled();
    return ctx.ok("GET", `/admin/agent-runs/${id}`, "stranger");
  };
  return { ...ctx, control, latest, run };
}

test("agent traces record real steps, stay admin-only and never hold private content", { timeout: 300000 }, async (t) => {
  const ctx = await setup();
  const { ok, fails, db, app, control, latest, run, users } = ctx;
  t.after(() => app.close());

  await t.test("a student answer records every executed step in order, with declared nodes only", async () => {
    const chat = await ok("POST", "/student/conversations", "s1", { title: "Plans" });
    await ok("POST", `/student/conversations/${chat.id}/message`, "s1", { message: SECRET_QUESTION });
    const summary = await latest();
    assert.deepEqual([summary.assistant, summary.role, summary.status, summary.company], ["student", "student", "completed", null]);
    const detail = await run(summary.id);
    assert.deepEqual(detail.steps.map((s) => [s.node, s.status]), [
      ["input", "completed"], ["identity", "completed"], ["context", "completed"], ["context.placement", "completed"],
      ["route", "completed"], ["research.web", "skipped"], ["context.competency", "skipped"], ["model.limit", "completed"],
      ["model.call", "completed"], ["model.validate", "completed"], ["persist", "completed"], ["output", "completed"],
    ]);
    const placement = detail.steps.find((s) => s.node === "context.placement");
    assert.equal(placement.parentSeq, detail.steps.find((s) => s.node === "context").seq, "nested under context");
    assert.equal(placement.meta.detail, "full");
    assert.equal(detail.steps.find((s) => s.node === "route").meta.decision, "chat_reply");
    assert.equal(detail.steps.find((s) => s.node === "model.call").meta.provider, "test");
    for (const step of detail.steps) {
      assert.ok(declaredNodes("student").has(step.node), `undeclared node ${step.node}`);
      assert.ok(step.durationMs === null || step.durationMs >= 0);
      assert.ok(!step.endedAt || new Date(step.endedAt) >= new Date(step.startedAt));
    }
    assert.ok(summary.durationMs >= 0);
    // Nothing the student wrote, nor any record, is stored.
    const stored = JSON.stringify((await db.query("SELECT r.summary, s.* FROM ops.agent_runs r JOIN ops.agent_steps s ON s.run_id=r.id")).rows);
    assert.equal(stored.includes("Zxqv-private-marker"), false);
    assert.equal(stored.includes("You have one open drive"), false);
    assert.equal(stored.includes("9.10"), false, "no CGPA");
    assert.equal(JSON.stringify(detail).includes(users.s1), false, "the actor id is never returned");
  });

  await t.test("branches the code did not take are recorded as skipped", async () => {
    const chat = await ok("POST", "/student/conversations", "s1", { title: "Hi" });
    await ok("POST", `/student/conversations/${chat.id}/message`, "s1", { message: "hello" });
    const detail = await run((await latest()).id);
    assert.equal(detail.steps.find((s) => s.node === "route").meta.decision, "greeting");
    assert.equal(detail.steps.find((s) => s.node === "model.call").status, "skipped");
    assert.equal(detail.steps.some((s) => s.node === "model.limit"), false, "no AI budget was used");
  });

  await t.test("a provider failure shows where it failed", async () => {
    const chat = await ok("POST", "/student/conversations", "s1", { title: "Fail" });
    control.fail = true;
    await fails(503, "POST", `/student/conversations/${chat.id}/message`, "s1", { message: "Plan my week" });
    control.fail = false;
    const summary = await latest();
    assert.deepEqual([summary.status, summary.errorCategory], ["failed", "model_provider"]);
    const detail = await run(summary.id);
    const call = detail.steps.find((s) => s.node === "model.call");
    assert.deepEqual([call.status, call.errorCategory], ["failed", "model_provider"]);
    assert.equal(detail.steps.some((s) => s.node === "persist"), false);
  });

  await t.test("authorization denials are recorded where the real check refused", async () => {
    // An account without a student link cannot use student FRIDAY.
    await fails(403, "POST", `/student/conversations/${randomUUID()}/message`, "wrongEmail", { message: "Show me R02's CGPA" });
    let summary = await latest();
    assert.deepEqual([summary.assistant, summary.role, summary.status], ["student", "none", "denied"]);
    let detail = await run(summary.id);
    assert.deepEqual(detail.steps.map((s) => [s.node, s.status, s.errorCategory]), [["input", "completed", null], ["identity", "denied", "forbidden"]]);
    // A placement officer is not a company member.
    await fails(403, "POST", `/company/friday/conversations/${randomUUID()}/message`, "officer", { message: "List Acme's applicants" });
    summary = await latest();
    assert.deepEqual([summary.assistant, summary.role, summary.status], ["company", "officer", "denied"]);
    detail = await run(summary.id);
    assert.equal(detail.steps.find((s) => s.node === "identity").status, "denied");
    assert.equal(detail.steps.some((s) => s.node === "context"), false, "no data was loaded");
  });

  await t.test("company runs show database calls nested under context and the company name", async () => {
    const chat = await ok("POST", "/company/friday/conversations", "hrA", {});
    await ok("POST", `/company/friday/conversations/${chat.id}/message`, "hrA", { message: "List the candidates for my drives" });
    const summary = await latest();
    assert.deepEqual([summary.assistant, summary.role, summary.company, summary.status], ["company", "company", "Acme Systems", "completed"]);
    const detail = await run(summary.id);
    const context = detail.steps.find((s) => s.node === "context");
    const children = detail.steps.filter((s) => s.parentSeq === context.seq).map((s) => s.node);
    assert.deepEqual(children, ["db.company.session", "db.company.requests", "db.company.drives"]);
    for (const step of detail.steps) assert.ok(declaredNodes("company").has(step.node), `undeclared node ${step.node}`);
  });

  await t.test("only accounts on the admin list can read traces or workflows", async () => {
    for (const who of ["s1", "officer", "hrA", "hrB", "wrongEmail"]) {
      await fails(403, "GET", "/admin/agent-runs", who);
      await fails(403, "GET", "/admin/agent-workflows", who);
      await fails(403, "GET", "/admin/session", who);
    }
    const anyRun = await latest();
    await fails(403, "GET", `/admin/agent-runs/${anyRun.id}`, "hrA");
    const workflows = await ok("GET", "/admin/agent-workflows", "stranger");
    assert.deepEqual(Object.keys(workflows), Object.keys(WORKFLOWS));
    const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer stranger" } });
    assert.deepEqual(session.json().data, { role: "admin", home: "/admin", onboardingRequired: false });
    // Removing someone from the list removes access immediately.
    await db.query("UPDATE ops.admins SET active=false WHERE user_id=$1", [users.stranger]);
    await fails(403, "GET", "/admin/agent-runs", "stranger");
    await db.query("UPDATE ops.admins SET active=true WHERE user_id=$1", [users.stranger]);
  });

  await t.test("officer FRIDAY reports its own run; others cannot write or append", async () => {
    const id = randomUUID();
    const now = new Date();
    await ok("POST", "/ops/traces", "officer", { id, assistant: "officer", startedAt: now.toISOString(), summary: { chars: 20 } });
    await fails(403, "POST", "/ops/traces", "s1", { id: randomUUID(), assistant: "officer", startedAt: now.toISOString() });
    await fails(403, "POST", "/ops/traces", "hrA", { id: randomUUID(), assistant: "officer", startedAt: now.toISOString() });
    const step = { seq: 1, node: "tool", kind: "tool", label: "find_students", status: "completed", started_at: now.toISOString(),
      ended_at: new Date(now.getTime() + 40).toISOString(), duration_ms: 40, meta: { tool: "find_students", prompt: "SECRET PROMPT", rows: 3 } };
    await fails(403, "POST", `/ops/traces/${id}/steps`, "s1", { steps: [step] });
    await fails(400, "POST", `/ops/traces/${id}/steps`, "officer", { steps: [{ ...step, node: "Bad Node!" }] });
    await ok("POST", `/ops/traces/${id}/steps`, "officer", { steps: [step], finish: { status: "completed" } });
    const detail = await run(id);
    assert.deepEqual([detail.assistant, detail.role, detail.status, detail.tools], ["officer", "officer", "completed", 1]);
    assert.deepEqual(detail.steps[0].meta, { tool: "find_students", rows: 3 }, "unknown metadata keys are dropped");
    // A finished run cannot be changed afterwards.
    await ok("POST", `/ops/traces/${id}/steps`, "officer", { steps: [{ ...step, status: "failed" }] });
    assert.equal((await run(id)).steps[0].status, "completed");
    const filtered = await ok("GET", "/admin/agent-runs?assistant=officer&tool=find_students", "stranger");
    assert.deepEqual(filtered.rows.map((r) => r.id), [id]);
  });

  await t.test("runs expire after seven days and are removed", async () => {
    const before = (await ok("GET", "/admin/agent-runs", "stranger")).counts.total;
    const oldest = (await db.query("SELECT id FROM ops.agent_runs ORDER BY started_at LIMIT 1")).rows[0].id;
    await db.query("UPDATE ops.agent_runs SET expires_at=now()-interval '1 second' WHERE id=$1", [oldest]);
    assert.equal((await ok("GET", "/admin/agent-runs", "stranger")).counts.total, before - 1, "expired runs are hidden at once");
    await fails(404, "GET", `/admin/agent-runs/${oldest}`, "stranger");
    const chat = await ok("POST", "/student/conversations", "s1", { title: "Purge" });
    await ok("POST", `/student/conversations/${chat.id}/message`, "s1", { message: "hello" });
    await tracesSettled();
    assert.equal((await db.query("SELECT count(*)::int n FROM ops.agent_runs WHERE id=$1", [oldest])).rows[0].n, 0, "purged on the next run");
  });
});
