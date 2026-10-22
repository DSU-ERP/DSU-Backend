import test from "node:test";
import assert from "node:assert/strict";
import { extractDocument } from "../src/modules/students/documents.js";

test("document extraction ignores Node watch-mode IPC reports", async () => {
  const previous = process.env.WATCH_REPORT_DEPENDENCIES;
  process.env.WATCH_REPORT_DEPENDENCIES = "1";
  try {
    const result = await extractDocument("skills.txt", Buffer.from("JavaScript, SQL and Git"));
    assert.equal(result.content, "JavaScript, SQL and Git");
    assert.equal(result.chars, 23);
  } finally {
    if (previous === undefined) delete process.env.WATCH_REPORT_DEPENDENCIES;
    else process.env.WATCH_REPORT_DEPENDENCIES = previous;
  }
});
