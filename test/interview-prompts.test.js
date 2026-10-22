import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInterviewFeedback, interviewSections, interviewPlanTask, INTERVIEW_EVALUATION_TASK, INTERVIEW_COACHING_TASK } from "../src/modules/students/interview-prompts.js";
const feedback = (overrides = {}) => ({
  scores: { relevance: 8, clarity: 8, confidence: 8, structure: 8, specificity: 8, roleFit: 8, communication: 8, depth: 8, conciseness: 8, accuracy: 8, overall: 8 },
  quality: "Poor", explanation: "Concrete explanation.", strengths: ["Evidence"], improvements: ["Clarify result"],
  followUp: "What changed after the fix?", turn: { kind: "answer", scored: true, reason: "Relevant." },
  star: { applicable: true, situation: true, task: true, action: true, result: false, missing: [], score: 7, feedback: "Missing outcome." },
  ...overrides,
});

test("planning, evaluation and coaching stay within educational preparation", () => {
  for (const task of [interviewPlanTask({ questionCount: 6, durationMinutes: 20, depth: "moderate" }), INTERVIEW_EVALUATION_TASK, INTERVIEW_COACHING_TASK]) {
    assert.match(task, /Educational scope only/);
    assert.match(task, /general academic-skills practice interview/);
    assert.match(task, /untrusted/);
  }
});
test("contradictory off-topic feedback never becomes a scored answer", () => {
  const result = normalizeInterviewFeedback(feedback({ turn: { kind: "off-topic", scored: true, reason: "Unrelated." } }));
  assert.equal(result.turn.scored, false);
  assert.ok(Object.values(result.scores).every((value) => value === 0));
  assert.deepEqual(result.strengths, []);
  assert.equal(result.followUp, null);
  assert.equal(result.star.applicable, false);
});
test("quality and missing STAR elements agree with their underlying evidence", () => {
  const result = normalizeInterviewFeedback(feedback());
  assert.equal(result.quality, "Strong");
  assert.deepEqual(result.star.missing, ["Result"]);
});
test("a follow-up cannot recursively ask another follow-up or require a fresh STAR story", () => {
  const result = normalizeInterviewFeedback(feedback(), { isFollowUp: true });
  assert.equal(result.followUp, null);
  assert.equal(result.star.applicable, false);
  assert.deepEqual(result.star.missing, []);
});
test("repeated or bundled follow-ups are discarded", () => {
  const question = "What changed after the fix?";
  assert.equal(normalizeInterviewFeedback(feedback(), { question }).followUp, null);
  assert.equal(normalizeInterviewFeedback(feedback({ followUp: "What changed? Why?" })).followUp, null);
});
test("plan sections count real questions even when the model duplicates or inflates sections", () => {
  const sections = interviewSections([{ focus: "Debugging" }, { focus: "Testing" }, { focus: "Debugging" }], [{ name: "Debugging", questionCount: 9, description: "Debugging evidence." }, { name: "Debugging", questionCount: 9, description: "Repeated." }]);
  assert.deepEqual(sections.map((section) => [section.name, section.questionCount]), [["Debugging", 2], ["Testing", 1]]);
});
