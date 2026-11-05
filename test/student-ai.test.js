import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  createStudentAI,
  studentProviderRouting,
} from "../src/modules/students/ai.js";

test("student AI uses only the ordered configured providers", () => {
  assert.deepEqual(
    studentProviderRouting(" baseten/fp8, deepinfra/fp8,baseten/fp8 "),
    {
      only: ["baseten/fp8", "deepinfra/fp8"],
      order: ["baseten/fp8", "deepinfra/fp8"],
      allow_fallbacks: true,
      require_parameters: true,
    },
  );
  assert.equal(studentProviderRouting("baseten/fp8").allow_fallbacks, false);
});

test("AI concurrency is reserved before database awaits and released on failure", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let connects = 0;
  const pool = {
    connect: async () => {
      connects++;
      await pending;
      throw Error("database temporarily unavailable");
    },
  };
  const generate = createStudentAI(
    pool,
    { STUDENT_AI_CONCURRENCY: 1 },
    async () => ({ text: "unused" }),
  );
  const first = generate(
    "a",
    "test",
    "task",
    {},
    z.object({ text: z.string() }),
  );
  const firstRejected = assert.rejects(first, (e) => e.statusCode === 503);
  await assert.rejects(
    () => generate("b", "test", "task", {}, z.object({ text: z.string() })),
    (e) => e.statusCode === 429 && e.code === "AI_BUSY",
  );
  assert.equal(connects, 1);
  release();
  await firstRejected;
  await assert.rejects(
    () => generate("b", "test", "task", {}, z.object({ text: z.string() })),
    (e) => e.statusCode === 503,
  );
  assert.equal(connects, 2);
});

function aiFixture(request, env = {}) {
  const finished = [], logs = [];
  const client = {
    async query(sql, values) {
      if (sql.includes("FROM erp.memberships")) return { rows: [{ id: "student" }] };
      if (sql.includes("count(*)::int n")) return { rows: [{ n: 0, running: 0 }] };
      if (sql.startsWith("INSERT INTO student.ai_requests")) return { rows: [{ id: "request" }] };
      if (sql.startsWith("UPDATE student.ai_requests")) finished.push(values[1]);
      return { rows: [] };
    }, release() {},
  };
  return {
    generate: createStudentAI({ connect: async () => client }, { OPENROUTER_API_KEY: "synthetic-key", STUDENT_AI_CONCURRENCY: 1, ...env }, undefined,
      { request, logger: { warn: (fields) => logs.push(fields) } }),
    finished, logs,
  };
}

test("provider timeouts release the AI slot and preserve private diagnostic boundaries", async () => {
  let calls = 0;
  const { generate, finished, logs } = aiFixture(async () => {
    if (++calls === 1) throw new DOMException("private provider detail", "TimeoutError");
    return Response.json({ choices: [{ message: { content: '{"text":"ready"}' } }] });
  });
  const schema = z.object({ text: z.string() });
  await assert.rejects(() => generate("actor", "interview.generate", "private task", { resume: "private resume" }, schema),
    (error) => error.statusCode === 504 && error.code === "AI_TIMEOUT");
  assert.deepEqual(await generate("actor", "interview.generate", "task", {}, schema), { text: "ready" });
  assert.deepEqual(finished, ["failed", "completed"]);
  assert.equal(logs[0].phase, "provider");
  assert.equal(logs[0].code, "TimeoutError");
  assert.doesNotMatch(JSON.stringify(logs), /private|synthetic-key|actor/);
});

test("malformed provider JSON is reported separately from service downtime", async () => {
  const { generate, finished, logs } = aiFixture(async () => Response.json({ choices: [{ message: { content: "not-json" } }] }));
  await assert.rejects(() => generate("actor", "interview.generate", "task", {}, z.object({ text: z.string() })),
    (error) => error.statusCode === 502 && error.code === "AI_INVALID_RESPONSE");
  assert.deepEqual(finished, ["failed"]);
  assert.equal(logs[0].phase, "decode");
});

test("interview planning and interactive evaluation retain the model, rubric and output budgets with bounded reasoning", async (t) => {
  const deadlines = [], requests = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  const { generate } = aiFixture(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: '{"text":"ready"}' } }] });
  });
  const schema = z.object({ text: z.string() });
  await generate("actor", "interview.generate", "task", { config: { questionCount: 6 } }, schema);
  await generate("actor", "interview.generate", "task", { config: { questionCount: 15 } }, schema);
  await generate("actor", "interview.evaluate", "task", {}, schema);
  assert.deepEqual(deadlines, [60000, 60000, 40000]);
  assert.deepEqual(requests[0].reasoning, { effort: "low", exclude: true });
  assert.equal(requests[0].max_tokens, 6000);
  assert.equal(requests[1].max_tokens, 10000);
  assert.deepEqual(requests[2].reasoning, { effort: "low", exclude: true });
  assert.equal(requests[2].max_tokens, 6000);
  assert.equal(requests[0].model, requests[2].model);
  assert.deepEqual(requests[0].provider, requests[2].provider);
});

test("low reasoning is scoped to interactive V4 work and preserves full structured validation", async () => {
  for (const model of ['deepseek/deepseek-v4.1-flash', 'other/model']) {
    const requests = [];
    const { generate } = aiFixture(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: '{"text":"ready"}' } }] });
    }, { STUDENT_AI_MODEL: model });
    for (const kind of ['chat.reply', 'chat.jd-match', 'interview.evaluate', 'interview.coach', 'assessment.generate', 'officer.assessment.generate'])
      await generate('actor', kind, 'Keep the full task.', {}, z.object({ text: z.string() }));
    for (let i = 0; i < requests.length; i++) {
      assert.deepEqual(requests[i].reasoning, model.startsWith('deepseek/deepseek-v4') && i < 4 ? { effort: 'low', exclude: true } : undefined);
      assert.equal(requests[i].response_format.json_schema.strict, true);
      assert.match(requests[i].messages[0].content, /Keep the full task/);
      assert.equal(requests[i].max_tokens, i < 4 ? 6000 : 14000);
      assert.equal(requests[i].model, model);
    }
  }
});

test("truncated and empty model output never becomes a saved plan", async () => {
  for (const [payload, code] of [
    [{ choices: [{ finish_reason: "length", message: { content: '{"text":"partial' } }] }, "AI_OUTPUT_LIMIT"],
    [{ choices: [{ finish_reason: "stop", message: { content: "" } }] }, "AI_INVALID_RESPONSE"],
    [{ error: { message: "private upstream failure" } }, "AI_INVALID_RESPONSE"],
  ]) {
    const { generate, finished, logs } = aiFixture(async () => Response.json(payload));
    await assert.rejects(() => generate("actor", "interview.generate", "task", {}, z.object({ text: z.string() })),
      (error) => error.statusCode === 502 && error.code === code);
    assert.deepEqual(finished, ["failed"]);
    assert.doesNotMatch(JSON.stringify(logs), /private upstream/);
  }
});

test("provider failures explain routing, credentials, credits and capacity without exposing upstream bodies", async () => {
  for (const [status, code, downstream, message] of [
    [400, "AI_NOT_CONFIGURED", 503, /model or provider routing/],
    [404, "AI_NOT_CONFIGURED", 503, /model or provider routing/],
    [401, "AI_NOT_CONFIGURED", 503, /credentials/],
    [403, "AI_NOT_CONFIGURED", 503, /credentials/],
    [402, "AI_UNAVAILABLE", 503, /insufficient credits/],
    [429, "AI_BUSY", 429, /rate-limiting/],
    [503, "AI_UNAVAILABLE", 503, /temporarily unavailable/],
    [504, "AI_TIMEOUT", 504, /timed out/],
  ]) {
    let calls = 0;
    const { generate, finished, logs } = aiFixture(async () => ++calls === 1
      ? Response.json({ error: { message: "private upstream body synthetic-key private resume" } }, { status })
      : Response.json({ choices: [{ message: { content: '{"text":"ready"}' } }] }));
    const schema = z.object({ text: z.string() });
    await assert.rejects(() => generate("actor", "interview.generate", "private task", {}, schema), error => {
      assert.equal(error.code, code);
      assert.equal(error.statusCode, downstream);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /private|synthetic-key/);
      return true;
    });
    assert.deepEqual(await generate("actor", "interview.generate", "task", {}, schema), { text: "ready" }, "a rejected request releases its concurrency slot");
    assert.deepEqual(finished, ["failed", "completed"]);
    assert.equal(logs[0].upstreamStatus, status);
    assert.doesNotMatch(JSON.stringify(logs), /private|synthetic-key/);
  }
});

const completion = (content, finish_reason = "stop") => Response.json({
  id: "synthetic", object: "chat.completion", created: 1, model: "synthetic",
  choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
});

test("the LangChain ChatOpenAI path sends the same OpenRouter request as the direct path", async () => {
  for (const kind of ["chat.reply", "chat.jd-match", "company.chat"]) {
    const bodies = [];
    const { generate } = aiFixture(async (url, options) => {
      assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer synthetic-key");
      bodies.push(JSON.parse(options.body));
      return completion('{"text":"ready"}');
    });
    const schema = z.object({ text: z.string() });
    assert.deepEqual(await generate("actor", kind, "Keep the full task.", { message: "synthetic" }, schema), { text: "ready" });
    assert.deepEqual(await generate("actor", kind, "Keep the full task.", { message: "synthetic" }, schema, { langchain: true }), { text: "ready" });
    const [direct, viaLangChain] = bodies;
    // LangChain adds only stream:false; every field the direct path sends is identical.
    assert.equal(viaLangChain.stream, false);
    for (const key of Object.keys(direct)) assert.deepEqual(viaLangChain[key], direct[key], `${kind}: ${key}`);
  }
});

test("the ChatOpenAI path keeps the same errors, slot release and private diagnostics", async () => {
  const schema = z.object({ text: z.string() });
  const cases = [
    [async () => Response.json({ error: { message: "private upstream body synthetic-key" } }, { status: 404 }), 503, "AI_NOT_CONFIGURED"],
    [async () => Response.json({ error: { message: "private upstream body synthetic-key" } }, { status: 429 }), 429, "AI_BUSY"],
    [async () => { throw new DOMException("private provider detail", "TimeoutError"); }, 504, "AI_TIMEOUT"],
    [async () => completion('{"text":"partial', "length"), 502, "AI_OUTPUT_LIMIT"],
    [async () => completion("not-json"), 502, "AI_INVALID_RESPONSE"],
    [async () => Response.json({ error: { message: "private upstream failure" } }), 502, "AI_INVALID_RESPONSE"],
  ];
  for (const [reply, statusCode, code] of cases) {
    let calls = 0;
    const { generate, finished, logs } = aiFixture(async (...args) => (++calls === 1 ? reply(...args) : completion('{"text":"ready"}')));
    await assert.rejects(() => generate("actor", "chat.reply", "private task", { resume: "private resume" }, schema, { langchain: true }), (error) => {
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private|synthetic-key/);
      return true;
    });
    assert.deepEqual(await generate("actor", "chat.reply", "task", {}, schema, { langchain: true }), { text: "ready" }, "the slot is released");
    assert.deepEqual(finished, ["failed", "completed"]);
    assert.doesNotMatch(JSON.stringify(logs), /private|synthetic-key|actor/);
  }
});
