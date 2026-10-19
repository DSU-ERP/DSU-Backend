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
