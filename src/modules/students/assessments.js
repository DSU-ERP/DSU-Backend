import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { runStudent, owned, activity } from "./context.js";
import { httpError } from "../../platform/http/errors.js";
import {
  CATEGORIES,
  LEVEL_LABELS,
  practiceFormat,
  practiceQuestions,
  round2,
} from "./practice-bank.js";
export const questionSchema = z
  .object({
    section: z.string().min(1).max(100),
    type: z.enum(["mcq", "short"]),
    question: z.string().min(5).max(3000),
    options: z.array(z.string().max(1000)).max(6),
    correctIndex: z.number().int().min(0).max(5).nullable(),
    expectedPoints: z.array(z.string().max(1500)).max(10),
    marks: z.number().int().min(1).max(10),
    explanation: z.string().max(3000),
  })
  .strict();
export function validateQuestions(questions) {
  if (!questions.length || questions.length > 50)
    throw httpError(
      400,
      "INVALID_QUESTIONS",
      "Use between one and 50 questions.",
    );
  // MCQs keep only their options and key; written items keep only non-empty
  // expected points. Options must be non-empty and distinct so the key is unambiguous.
  const normalised = questions.map((q) =>
    q.type === "mcq"
      ? { ...q, expectedPoints: [] }
      : {
          ...q,
          options: [],
          correctIndex: null,
          expectedPoints: q.expectedPoints
            .map((point) => point.trim())
            .filter(Boolean),
        },
  );
  for (const q of normalised)
    if (
      q.type === "mcq"
        ? q.options.length < 2 ||
          q.correctIndex === null ||
          q.correctIndex >= q.options.length ||
          q.options.some((option) => !option.trim()) ||
          new Set(q.options.map((option) => option.trim().toLowerCase()))
            .size !== q.options.length
        : !q.expectedPoints.length
    )
      throw httpError(
        400,
        "INVALID_ANSWER_KEY",
        "Every question needs distinct options with a valid answer key, or expected points.",
      );
  return normalised.map((q, index) => ({ ...q, id: "q" + (index + 1) }));
}
// Severity is derived on the server from the event kind; clients cannot set it.
export const INTEGRITY_SEVERITY = {
  "fullscreen-exit": "high",
  clipboard: "high",
  "tab-hidden": "medium",
  inactive: "medium",
  "window-blur": "low",
};
export const severityOf = (kind) => INTEGRITY_SEVERITY[kind] || "low";
const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };
// A repeat of the same kind this soon is the same incident (a fullscreen
// transition, a browser prompt or a client retry) and is not stored twice.
export const INTEGRITY_REPEAT_MS = 2000;
export const INTEGRITY_LIMIT = 200;
/**
 * Keep at most `limit` events, dropping the oldest event of the lowest
 * severity first, so a burst of low-severity events never evicts a high one.
 */
export function capIntegrity(events, limit = INTEGRITY_LIMIT) {
  const kept = [...events];
  while (kept.length > limit) {
    const rank = (event) => SEVERITY_RANK[severityOf(event.kind)];
    const lowest = Math.min(...kept.map(rank));
    kept.splice(
      kept.findIndex((event) => rank(event) === lowest),
      1,
    );
  }
  return kept;
}
export function integritySummary(events = []) {
  const summary = { total: 0, high: 0, medium: 0, low: 0 };
  for (const event of events) {
    summary.total++;
    summary[severityOf(event.kind)]++;
  }
  return summary;
}
const withSeverity = (events = []) =>
  events.map((event) => ({ ...event, severity: severityOf(event.kind) }));
export function sectionBreakdown(review = []) {
  const sections = new Map();
  for (const q of review) {
    const section = sections.get(q.section) || {
      name: q.section,
      score: 0,
      maximum: 0,
      questions: 0,
      correct: 0,
    };
    section.score += q.score;
    section.maximum += q.marks;
    section.questions++;
    if (q.state === "correct") section.correct++;
    sections.set(q.section, section);
  }
  return [...sections.values()].map((section) => ({
    ...section,
    score: round2(section.score),
    percentage: section.maximum
      ? Math.round((section.score / section.maximum) * 100)
      : 0,
  }));
}
/**
 * Assigned tests default to releasing answers after the window closes, so a
 * student who finishes early cannot pass the key to classmates still testing.
 */
export function answerRelease(assessment, now = Date.now()) {
  const policy =
    assessment.config?.revealAnswers === "immediately"
      ? "immediately"
      : "after_close";
  const closes =
    assessment.kind === "assigned" && assessment.closes_at
      ? new Date(assessment.closes_at).getTime()
      : null;
  return {
    policy,
    withheld: policy === "after_close" && closes !== null && closes > now,
    releaseAt: closes === null ? null : new Date(closes).toISOString(),
  };
}
// Per-question correctness narrows an MCQ key, so it is withheld with the key.
const WITHHELD_FIELDS = new Set([
  "correctIndex",
  "expectedPoints",
  "explanation",
  "expected",
  "feedback",
  "score",
  "state",
]);
// Section marks and the section-level strengths, weaknesses and
// recommendations are derived from per-question marks: a one-question section
// would reveal that question's result. They are withheld too; the totals stay.
const WITHHELD_RESULT_FIELDS = new Set([
  "sections",
  "strengths",
  "weaknesses",
  "recommendations",
]);
export function presentResult(result, release) {
  if (!result || result.pending) return result;
  const integrity = withSeverity(result.integrity || []),
    summary = integritySummary(integrity);
  const shown = {
    ...result,
    sections: result.sections || sectionBreakdown(result.review),
    integrity,
    integritySummary: summary,
    highRisk: summary.high,
    answersWithheld: release.withheld,
    answersReleaseAt: release.releaseAt,
  };
  if (!release.withheld) return shown;
  return {
    ...Object.fromEntries(
      Object.entries(shown).filter(([key]) => !WITHHELD_RESULT_FIELDS.has(key)),
    ),
    review: (result.review || []).map((q) =>
      Object.fromEntries(
        Object.entries(q).filter(([key]) => !WITHHELD_FIELDS.has(key)),
      ),
    ),
  };
}
const insightItem = z
  .object({
    text: z.string().trim().min(3).max(400),
    questionIds: z.array(z.string().max(10)).min(1).max(10),
  })
  .strict();
export const insightsSchema = z
  .object({
    strengths: z.array(insightItem).max(5),
    weaknesses: z.array(insightItem).max(5),
    suggestions: z.array(insightItem).max(5),
  })
  .strict();
/** Reasons an AI diagnosis is not supported by the stored review. */
export function insightProblems(insights, review) {
  const states = new Map(review.map((q) => [q.id, q.state]));
  const problems = [];
  for (const group of ["strengths", "weaknesses", "suggestions"])
    for (const item of insights[group])
      for (const id of item.questionIds) {
        const state = states.get(id);
        if (!state) problems.push(`${group} cites unknown question ${id}`);
        else if (
          group === "strengths" &&
          (state === "incorrect" || state === "unanswered")
        )
          problems.push(`strength cites ${state} question ${id}`);
        else if (group === "weaknesses" && state === "correct")
          problems.push(`weakness cites correct question ${id}`);
      }
  return problems;
}
const clip = (value, size) => String(value ?? "").slice(0, size);
export const codeHash = (code, secret) =>
  createHash("sha256")
    .update(secret + ":" + code)
    .digest("hex");
export const newClassCode = () => String(randomInt(100000, 1000000));
export function publicQuestions(questions) {
  return questions.map(
    ({ correctIndex, expectedPoints, explanation, ...rest }) => rest,
  );
}
function answerMap(value, questions) {
  const answers = z.record(z.string(), z.string().max(10000)).parse(value);
  for (const [id, answer] of Object.entries(answers)) {
    const q = questions.find((item) => item.id === id);
    if (
      !q ||
      (q.type === "mcq" &&
        answer !== "" &&
        (!/^\d$/.test(answer) || Number(answer) >= q.options.length))
    )
      throw httpError(
        400,
        "INVALID_ANSWERS",
        "An answer does not match this assessment.",
      );
  }
  return answers;
}
async function paper(client, id, actor, batch, existingAttempt = false) {
  const result = (
    await client.query("SELECT * FROM student.assessments WHERE id=$1", [id])
  ).rows[0];
  if (
    !result ||
    (result.kind !== "assigned" && result.creator_id !== actor) ||
    (result.kind === "assigned" &&
      !existingAttempt &&
      (!result.published || (result.batch && result.batch !== batch)))
  )
    throw httpError(404, "NOT_FOUND", "This assessment is unavailable.");
  return result;
}
export function registerAssessmentRoutes(api, { pool, generate, env }) {
  const secret = env.ASSESSMENT_CODE_SECRET || env.SERVICE_TOKEN;
  const evaluate = async (actor, id) => {
    const context = await runStudent(pool, actor, async (client, official) => {
      const attempt = await owned(client, "attempts", id, actor, true),
        assessment = await paper(
          client,
          attempt.assessment_id,
          actor,
          official.source_batch,
          true,
        );
      if (attempt.status === "active")
        throw httpError(
          409,
          "SUBMIT_FIRST",
          "Submit the test before requesting a result.",
        );
      return { attempt, assessment };
    });
    const { attempt, assessment } = context;
    if (attempt.result)
      return presentResult(attempt.result, answerRelease(assessment));
    const written = assessment.questions.filter(
      (q) => q.type === "short" && attempt.answers[q.id]?.trim(),
    );
    let savedGrading = attempt.grading || {};
    const batch = written.filter((q) => !savedGrading[q.id]).slice(0, 5);
    if (batch.length) {
      const result = await generate(
        actor,
        "assessment.evaluate",
        "Grade the student's written answers against the supplied expected points. Award partial credit where justified, never more than the maximum. Return exactly one result for each supplied question ID. Explain missing evidence constructively.",
        {
          questions: batch.map((q) => ({
            id: q.id,
            question: q.question,
            expectedPoints: q.expectedPoints.join("; ").slice(0, 3000),
            maximum: q.marks,
            answer: attempt.answers[q.id],
          })),
        },
        z
          .object({
            results: z
              .array(
                z.object({
                  id: z.string(),
                  score: z.number().nonnegative(),
                  feedback: z.string().max(2000),
                }),
              )
              .length(batch.length),
          })
          .strict(),
      );
      if (
        new Set(result.results.map((item) => item.id)).size !== batch.length ||
        result.results.some(
          (item) =>
            !batch.some((q) => q.id === item.id) ||
            item.score > batch.find((q) => q.id === item.id).marks,
        )
      )
        throw httpError(
          502,
          "INVALID_GRADING",
          "The written-answer evaluation was incomplete. Retry evaluation.",
        );
      savedGrading = await runStudent(pool, actor, async (client) => {
        const locked = await owned(client, "attempts", id, actor, true);
        const merged = { ...(locked.grading || {}) };
        for (const item of result.results)
          if (!merged[item.id]) merged[item.id] = item;
        await client.query(
          "UPDATE student.attempts SET grading=$2 WHERE id=$1",
          [id, JSON.stringify(merged)],
        );
        return merged;
      });
    }
    const remaining = written.filter((q) => !savedGrading[q.id]).length;
    if (remaining)
      return {
        pending: true,
        graded: written.length - remaining,
        total: written.length,
      };
    const grading = Object.values(savedGrading);
    const review = assessment.questions.map((q) => {
      const answer = attempt.answers[q.id] || "",
        writtenResult = grading.find((item) => item.id === q.id);
      const score = !answer.trim()
        ? 0
        : q.type === "mcq"
          ? Number(answer) === q.correctIndex
            ? q.marks
            : 0
          : writtenResult.score;
      return {
        ...q,
        answer,
        selectedText:
          q.type === "mcq" && answer !== ""
            ? q.options[Number(answer)]
            : answer,
        expected:
          q.type === "mcq"
            ? q.options[q.correctIndex]
            : q.expectedPoints.join("; "),
        score,
        state: !answer.trim()
          ? "unanswered"
          : score === q.marks
            ? "correct"
            : score > 0
              ? "partial"
              : "incorrect",
        feedback: writtenResult?.feedback || q.explanation,
      };
    });
    const total = review.reduce((sum, q) => sum + q.marks, 0),
      score = round2(review.reduce((sum, q) => sum + q.score, 0)),
      integrity = withSeverity(attempt.integrity),
      flags = integritySummary(integrity),
      percentage = Math.round((score / total) * 100);
    const weak = [
      ...new Set(review.filter((q) => q.score < q.marks).map((q) => q.section)),
    ];
    const result = {
      title: assessment.title,
      difficulty: assessment.config.difficulty,
      score,
      maximum: total,
      percentage,
      attempted: review.filter((q) => q.answer.trim()).length,
      correct: review.filter((q) => q.state === "correct").length,
      partial: review.filter((q) => q.state === "partial").length,
      unanswered: review.filter((q) => q.state === "unanswered").length,
      strengths: [
        ...new Set(
          review.filter((q) => q.state === "correct").map((q) => q.section),
        ),
      ],
      weaknesses: weak,
      recommendations: weak.map(
        (section) =>
          `Help me practise ${section}, starting with the questions I missed.`,
      ),
      review,
      sections: sectionBreakdown(review),
      kind: assessment.kind,
      category: assessment.category,
      level: assessment.level,
      integrity,
      integritySummary: flags,
      highRisk: flags.high,
      submittedAt: attempt.submitted_at,
      durationSeconds: Math.min(
        assessment.config.durationMinutes * 60,
        Math.max(
          0,
          Math.round(
            (Date.parse(attempt.submitted_at) -
              Date.parse(attempt.started_at)) /
              1000,
          ),
        ),
      ),
    };
    return runStudent(pool, actor, async (client) => {
      const locked = await owned(client, "attempts", id, actor, true);
      if (!locked.result) {
        await client.query(
          "UPDATE student.attempts SET status='completed',result=$2 WHERE id=$1",
          [id, JSON.stringify(result)],
        );
        await activity(client, actor, "assessment.completed", id);
      }
      return presentResult(locked.result || result, answerRelease(assessment));
    });
  };
  api.post("/student/assessments/generate", async (req) => {
    const input = z
      .object({
        source: z.enum(["topics", "jd"]),
        context: z.string().trim().min(10).max(30000),
        sections: z
          .array(
            z
              .object({
                name: z.string().trim().min(2).max(100),
                count: z.number().int().min(1).max(50),
                type: z.enum(["mcq", "short", "mixed"]),
              })
              .strict(),
          )
          .min(1)
          .max(8),
        difficulty: z.enum(["easy", "medium", "hard"]),
        durationMinutes: z.number().int().min(5).max(180),
        fullscreen: z.boolean(),
      })
      .strict()
      .parse(req.body);
    const count = input.sections.reduce((sum, item) => sum + item.count, 0);
    if (
      count > 50 ||
      new Set(input.sections.map((section) => section.name)).size !==
        input.sections.length
    )
      throw httpError(
        400,
        "INVALID_BLUEPRINT",
        "Use distinct section names and at most 50 questions.",
      );
    const generated = await generate(
      req.actor.id,
      "assessment.generate",
      `Create exactly ${count} questions according to the section counts and types. MCQs require two to six distinct options and a correct zero-based index. Written questions require expected points. Include explanations. Use realistic, correct questions at the requested difficulty.`,
      input,
      z
        .object({
          title: z.string().max(200),
          questions: z.array(questionSchema).length(count),
        })
        .strict(),
    );
    let questions;
    try {
      questions = validateQuestions(generated.questions);
    } catch {
      throw httpError(
        502,
        "BLUEPRINT_MISMATCH",
        "The generated test had an invalid answer key. Please retry.",
      );
    }
    for (const section of input.sections)
      if (
        questions.filter((q) => q.section === section.name).length !==
          section.count ||
        questions.some(
          (q) =>
            q.section === section.name &&
            section.type !== "mixed" &&
            q.type !== section.type,
        )
      )
        throw httpError(
          502,
          "BLUEPRINT_MISMATCH",
          "The generated test did not match your blueprint. Please retry.",
        );
    return runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          "INSERT INTO student.assessments(creator_id,kind,title,questions,config) VALUES($1,'ai',$2,$3,$4) RETURNING id",
          [
            req.actor.id,
            generated.title,
            JSON.stringify(questions),
            JSON.stringify(input),
          ],
        )
      ).rows[0],
    }));
  });
  api.get("/student/assessments/history", async (req) =>
    runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          "SELECT a.id,a.status,a.started_at,a.submitted_at,a.expires_at,a.result,a.integrity,t.title,t.kind,t.category,t.level,t.closes_at,t.config->>'revealAnswers' reveal_answers FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE a.user_id=$1 ORDER BY a.started_at DESC LIMIT 100",
          [req.actor.id],
        )
      ).rows.map(({ integrity, reveal_answers, closes_at, ...row }) => {
        const release = answerRelease({
          kind: row.kind,
          closes_at,
          config: { revealAnswers: reveal_answers },
        });
        // History lists summaries; the full review stays on the result page.
        const { review: _review, ...summary } =
          presentResult(row.result, release) || {};
        return {
          ...row,
          result: row.result ? summary : null,
          integritySummary: integritySummary(integrity),
          answersReleaseAt: release.releaseAt,
        };
      }),
    })),
  );
  // Written practice items need AI grading. Without a configured provider,
  // papers are objective-only so no level can become impossible to complete.
  const practiceOptions = { written: generate.configured !== false };
  api.get("/student/practice", async (req) =>
    runStudent(pool, req.actor.id, async (client) => ({
      data: {
        categories: CATEGORIES,
        levels: LEVEL_LABELS,
        formats: Object.fromEntries(
          Object.keys(CATEGORIES).map((category) => [
            category,
            [1, 2, 3, 4, 5].map((level) => ({
              level,
              ...practiceFormat(category, level, practiceOptions),
            })),
          ]),
        ),
        progress: (
          await client.query(
            "SELECT t.category,t.level,max((a.result->>'percentage')::int)::int best,count(*)::int attempts FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE a.user_id=$1 AND a.status='completed' AND t.kind='practice' GROUP BY t.category,t.level",
            [req.actor.id],
          )
        ).rows,
        // Unfinished papers, so a level resumes its saved paper.
        active: (
          await client.query(
            "SELECT DISTINCT ON (t.category,t.level) t.category,t.level,a.id attempt FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE a.user_id=$1 AND a.status='active' AND t.kind='practice' ORDER BY t.category,t.level,a.started_at DESC",
            [req.actor.id],
          )
        ).rows,
      },
    })),
  );
  api.post("/student/practice/:category/:level", async (req) => {
    const category = z.enum(Object.keys(CATEGORIES)).parse(req.params.category),
      level = z.coerce.number().int().min(1).max(5).parse(req.params.level);
    // The server chooses the seed; nothing in the body can influence a paper.
    z.object({}).strict().parse(req.body ?? {});
    return runStudent(pool, req.actor.id, async (client) => {
      if (level > 1) {
        const previous = (
          await client.query(
            "SELECT 1 FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE a.user_id=$1 AND t.category=$2 AND t.level=$3 AND a.status='completed' AND (a.result->>'percentage')::numeric>=70 LIMIT 1",
            [req.actor.id, category, level - 1],
          )
        ).rows[0];
        if (!previous)
          throw httpError(
            409,
            "LEVEL_LOCKED",
            "Earn at least 70% in the previous level to unlock this one.",
          );
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `student.practice.${req.actor.id}.${category}.${level}`,
      ]);
      // An unfinished attempt keeps its saved paper and original deadline, so
      // reopening a level cannot redraw a paper that has been seen.
      const unfinished = (
        await client.query(
          "SELECT t.id FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE a.user_id=$1 AND a.status='active' AND t.kind='practice' AND t.creator_id=$1 AND t.category=$2 AND t.level=$3 ORDER BY a.started_at DESC LIMIT 1",
          [req.actor.id, category, level],
        )
      ).rows[0];
      if (unfinished) return { data: { id: unfinished.id, resumed: true } };
      // A recent paper that was never started (a repeated click) is reused
      // rather than stored again, if it suits the current AI availability.
      const unstarted = (
        await client.query(
          `SELECT t.id FROM student.assessments t WHERE t.creator_id=$1 AND t.kind='practice' AND t.category=$2 AND t.level=$3 AND t.created_at>now()-interval '1 hour' AND ($4::boolean OR NOT t.questions @> '[{"type":"short"}]'::jsonb) AND NOT EXISTS(SELECT 1 FROM student.attempts a WHERE a.assessment_id=t.id) ORDER BY t.created_at DESC LIMIT 1`,
          [req.actor.id, category, level, practiceOptions.written],
        )
      ).rows[0];
      if (unstarted) return { data: { id: unstarted.id, resumed: false } };
      // A fresh server-generated seed per paper varies numbers, items and
      // option order; the paper and its seed are stored with the assessment.
      const seed = randomInt(1, 2 ** 31 - 1);
      const { rows } = await client.query(
        "INSERT INTO student.assessments(creator_id,kind,title,questions,config,category,level) VALUES($1,'practice',$2,$3,$4,$5,$6) RETURNING id",
        [
          req.actor.id,
          `${CATEGORIES[category].name} · Level ${level}`,
          JSON.stringify(
            practiceQuestions(category, level, seed, practiceOptions),
          ),
          JSON.stringify({
            difficulty: level <= 2 ? "easy" : level <= 4 ? "medium" : "hard",
            durationMinutes: practiceFormat(category, level, practiceOptions)
              .durationMinutes,
            fullscreen: false,
            seed,
          }),
          category,
          level,
        ],
      );
      return { data: { ...rows[0], resumed: false } };
    });
  });
  api.post(
    "/student/assigned/unlock",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const { code } = z
        .object({ code: z.string().regex(/^\d{6}$/) })
        .strict()
        .parse(req.body);
      return runStudent(pool, req.actor.id, async (client, official) => {
        const assessment = (
          await client.query(
            "SELECT id,title,config,batch,opens_at,closes_at,jsonb_array_length(questions)::int count,student.assessment_creator(id) creator FROM student.assessments WHERE kind='assigned' AND code_hash=$1 AND published AND (batch IS NULL OR batch=$2) AND opens_at<=now() AND closes_at>now()",
            [codeHash(code, secret), official.source_batch],
          )
        ).rows[0];
        if (!assessment)
          throw httpError(
            404,
            "CODE_UNAVAILABLE",
            "This code is invalid, not open, expired or unavailable for your batch.",
          );
        return { data: assessment };
      });
    },
  );
  api.post("/student/assessments/:id/start", async (req) => {
    const input = z
        .object({
          code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
          accepted: z.literal(true),
        })
        .strict()
        .parse(req.body),
      id = z.uuid().parse(req.params.id);
    return runStudent(pool, req.actor.id, async (client, official) => {
      const assessment = await paper(
        client,
        id,
        req.actor.id,
        official.source_batch,
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "student.test." + req.actor.id + id,
      ]);
      const prior = (
        await client.query(
          "SELECT id,status FROM student.attempts WHERE user_id=$1 AND assessment_id=$2 ORDER BY started_at DESC LIMIT 1",
          [req.actor.id, id],
        )
      ).rows[0];
      if (prior?.status === "active")
        return { data: { id: prior.id, resumed: true } };
      if (assessment.kind === "assigned") {
        if (prior && !assessment.config.allowRetake)
          throw httpError(
            409,
            "ALREADY_TAKEN",
            "You have already submitted this assigned assessment.",
          );
        if (
          !input.code ||
          codeHash(input.code, secret) !== assessment.code_hash ||
          Date.parse(assessment.opens_at) > Date.now() ||
          Date.parse(assessment.closes_at) <= Date.now()
        )
          throw httpError(
            403,
            "CODE_REQUIRED",
            "Unlock this assessment with a valid current class code.",
          );
      }
      return {
        data: (
          await client.query(
            "INSERT INTO student.attempts(user_id,assessment_id,expires_at,identity) VALUES($1,$2,least(now()+make_interval(mins=>$3),coalesce($4::timestamptz,'infinity'::timestamptz)),$5) RETURNING id",
            [
              req.actor.id,
              id,
              assessment.config.durationMinutes,
              assessment.closes_at,
              JSON.stringify({
                name: official.full_name,
                usn: official.enrollment_no,
                department: official.department_short_name,
              }),
            ],
          )
        ).rows[0],
      };
    });
  });
  api.get("/student/attempts/:id", async (req) =>
    runStudent(pool, req.actor.id, async (client, official) => {
      const attempt = await owned(
          client,
          "attempts",
          z.uuid().parse(req.params.id),
          req.actor.id,
        ),
        assessment = await paper(
          client,
          attempt.assessment_id,
          req.actor.id,
          official.source_batch,
          true,
        );
      const release = answerRelease(assessment);
      return {
        data: {
          ...attempt,
          result: presentResult(attempt.result, release),
          // Saved written-answer grading carries feedback and scores.
          grading: release.withheld
            ? Object.fromEntries(
                Object.keys(attempt.grading || {}).map((key) => [
                  key,
                  { id: key },
                ]),
              )
            : attempt.grading,
          insights: release.withheld ? null : attempt.insights,
          integrity: withSeverity(attempt.integrity),
          answerRelease: release,
          title: assessment.title,
          kind: assessment.kind,
          category: assessment.category,
          level: assessment.level,
          config: {
            durationMinutes: assessment.config.durationMinutes,
            fullscreen: !!assessment.config.fullscreen,
            difficulty: assessment.config.difficulty,
          },
          questions:
            attempt.status === "completed"
              ? undefined
              : publicQuestions(assessment.questions),
          official: { name: official.full_name, usn: official.enrollment_no },
        },
      };
    }),
  );
  api.post("/student/attempts/:id/save", async (req) => {
    const input = z
      .object({
        answers: z.record(z.string(), z.string().max(10000)),
        marked: z.array(z.string()).max(50),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client, official) => {
      const attempt = await owned(
          client,
          "attempts",
          z.uuid().parse(req.params.id),
          req.actor.id,
          true,
        ),
        assessment = await paper(
          client,
          attempt.assessment_id,
          req.actor.id,
          official.source_batch,
          true,
        );
      if (
        attempt.status !== "active" ||
        Date.parse(attempt.expires_at) <= Date.now()
      )
        throw httpError(
          409,
          "TIME_ENDED",
          "Time has ended. Submit your saved answers.",
        );
      const answers = answerMap(input.answers, assessment.questions);
      const { rows } = await client.query(
        "UPDATE student.attempts SET answers=$2,marked=$3,revision=revision+1 WHERE id=$1 AND revision=$4 RETURNING revision",
        [
          attempt.id,
          JSON.stringify(answers),
          JSON.stringify(
            input.marked.filter((id) =>
              assessment.questions.some((q) => q.id === id),
            ),
          ),
          input.revision,
        ],
      );
      if (!rows[0])
        throw httpError(
          409,
          "ATTEMPT_CHANGED",
          "This test changed in another window. Reload to recover the latest saved answers.",
        );
      return { data: rows[0] };
    });
  });
  api.post("/student/attempts/:id/submit", async (req) => {
    const id = z.uuid().parse(req.params.id),
      input = z
        .object({ answers: z.record(z.string(), z.string().max(10000)) })
        .strict()
        .parse(req.body);
    await runStudent(pool, req.actor.id, async (client, official) => {
      const attempt = await owned(client, "attempts", id, req.actor.id, true),
        assessment = await paper(
          client,
          attempt.assessment_id,
          req.actor.id,
          official.source_batch,
          true,
        );
      if (attempt.status === "active") {
        const answers =
          Date.parse(attempt.expires_at) <= Date.now()
            ? attempt.answers
            : answerMap(input.answers, assessment.questions);
        await client.query(
          "UPDATE student.attempts SET status='submitted',answers=$2,submitted_at=least(now(),expires_at),revision=revision+1 WHERE id=$1",
          [id, JSON.stringify(answers)],
        );
      }
    });
    return { data: await evaluate(req.actor.id, id) };
  });
  api.post("/student/attempts/:id/evaluate", async (req) => ({
    data: await evaluate(req.actor.id, z.uuid().parse(req.params.id)),
  }));
  api.post("/student/attempts/:id/integrity", async (req) => {
    const input = z
      .object({
        kind: z.enum(Object.keys(INTEGRITY_SEVERITY)),
        seconds: z.number().int().min(0).max(3600).default(0),
      })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client) => {
      const attempt = await owned(
        client,
        "attempts",
        z.uuid().parse(req.params.id),
        req.actor.id,
        true,
      );
      const counts = (events) => ({
        events: events.length,
        highRisk: integritySummary(events).high,
      });
      const now = Date.now();
      // Only events during the attempt's own time are recorded.
      if (attempt.status !== "active" || Date.parse(attempt.expires_at) <= now)
        return { data: counts(attempt.integrity) };
      const previous = attempt.integrity.findLast(
        (event) => event.kind === input.kind,
      );
      if (previous && now - Date.parse(previous.at) < INTEGRITY_REPEAT_MS)
        return { data: counts(attempt.integrity) };
      const events = capIntegrity([
        ...attempt.integrity,
        {
          kind: input.kind,
          // Only inactivity has a duration; the other kinds are instants.
          seconds: input.kind === "inactive" ? input.seconds : 0,
          severity: severityOf(input.kind),
          at: new Date(now).toISOString(),
        },
      ]);
      await client.query(
        "UPDATE student.attempts SET integrity=$2 WHERE id=$1",
        [attempt.id, JSON.stringify(events)],
      );
      return { data: counts(events) };
    });
  });
  // AI diagnosis grounded in the stored review. Every cited question must
  // exist and match the claim; nothing is stored or shown otherwise.
  api.post("/student/attempts/:id/insights", async (req) => {
    const id = z.uuid().parse(req.params.id);
    const { attempt, assessment } = await runStudent(
      pool,
      req.actor.id,
      async (client, official) => {
        const attempt = await owned(client, "attempts", id, req.actor.id),
          assessment = await paper(
            client,
            attempt.assessment_id,
            req.actor.id,
            official.source_batch,
            true,
          );
        if (!attempt.result)
          throw httpError(
            409,
            "RESULT_FIRST",
            "Finish the evaluation before requesting a diagnosis.",
          );
        if (answerRelease(assessment).withheld)
          throw httpError(
            409,
            "ANSWERS_WITHHELD",
            "A diagnosis becomes available when answers are released after the test closes.",
          );
        return { attempt, assessment };
      },
    );
    if (attempt.insights) return { data: attempt.insights };
    const review = attempt.result.review;
    const output = await generate(
      req.actor.id,
      "assessment.insights",
      "Diagnose this assessment result from the supplied review only. Each item cites the question IDs that support it. Strengths may cite only questions whose state is correct or partial. Weaknesses may cite only questions whose state is incorrect, partial or unanswered. Suggestions are concrete practice actions tied to the cited questions. Use at most five items per list; return an empty list rather than an unsupported claim.",
      {
        title: assessment.title,
        difficulty: assessment.config.difficulty,
        score: attempt.result.score,
        maximum: attempt.result.maximum,
        questions: review.map((q) => ({
          id: q.id,
          section: q.section,
          type: q.type,
          state: q.state,
          score: q.score,
          marks: q.marks,
          question: clip(q.question, 500),
          expected: clip(q.expected, 600),
          answer: clip(q.selectedText ?? q.answer, 600),
        })),
      },
      insightsSchema,
    );
    if (insightProblems(output, review).length)
      throw httpError(
        502,
        "AI_INVALID_RESPONSE",
        "The AI diagnosis cited questions that do not support it. Retry; nothing was saved.",
      );
    const tidy = (items) =>
      items.map((item) => ({
        text: item.text,
        questionIds: [...new Set(item.questionIds)],
      }));
    const insights = {
      strengths: tidy(output.strengths),
      weaknesses: tidy(output.weaknesses),
      suggestions: tidy(output.suggestions),
      generatedAt: new Date().toISOString(),
    };
    return runStudent(pool, req.actor.id, async (client) => {
      const locked = await owned(client, "attempts", id, req.actor.id, true);
      if (locked.insights) return { data: locked.insights };
      await client.query("UPDATE student.attempts SET insights=$2 WHERE id=$1", [
        id,
        JSON.stringify(insights),
      ]);
      await activity(client, req.actor.id, "assessment.insights", id);
      return { data: insights };
    });
  });
}
