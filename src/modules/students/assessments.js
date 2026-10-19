import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { runStudent, owned, activity } from "./context.js";
import { httpError } from "../../platform/http/errors.js";
import { CATEGORIES, practiceQuestions } from "./practice-bank.js";
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
  for (const q of questions)
    if (
      q.type === "mcq"
        ? q.options.length < 2 ||
          q.correctIndex === null ||
          q.correctIndex >= q.options.length
        : !q.expectedPoints.length
    )
      throw httpError(
        400,
        "INVALID_ANSWER_KEY",
        "Every question needs a valid answer key or expected points.",
      );
  return questions.map((q, index) => ({ ...q, id: "q" + (index + 1) }));
}
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
    if (context.attempt.result) return context.attempt.result;
    const { attempt, assessment } = context;
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
      score = review.reduce((sum, q) => sum + q.score, 0),
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
      kind: assessment.kind,
      category: assessment.category,
      level: assessment.level,
      integrity: attempt.integrity,
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
      return locked.result || result;
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
    const questions = validateQuestions(generated.questions);
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
          "SELECT a.id,a.status,a.started_at,a.submitted_at,a.expires_at,a.result,t.title,t.kind,t.category,t.level FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE a.user_id=$1 ORDER BY a.started_at DESC LIMIT 100",
          [req.actor.id],
        )
      ).rows,
    })),
  );
  api.get("/student/practice", async (req) =>
    runStudent(pool, req.actor.id, async (client) => ({
      data: {
        categories: CATEGORIES,
        progress: (
          await client.query(
            "SELECT t.category,t.level,max((a.result->>'percentage')::int)::int best,count(*)::int attempts FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE a.user_id=$1 AND a.status='completed' AND t.kind='practice' GROUP BY t.category,t.level",
            [req.actor.id],
          )
        ).rows,
      },
    })),
  );
  api.post("/student/practice/:category/:level", async (req) => {
    const category = z.enum(Object.keys(CATEGORIES)).parse(req.params.category),
      level = z.coerce.number().int().min(1).max(5).parse(req.params.level);
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
      const { rows } = await client.query(
        "INSERT INTO student.assessments(creator_id,kind,title,questions,config,category,level) VALUES($1,'practice',$2,$3,$4,$5,$6) RETURNING id",
        [
          req.actor.id,
          `${CATEGORIES[category].name} · Level ${level}`,
          JSON.stringify(practiceQuestions(category, level)),
          JSON.stringify({
            difficulty: level <= 2 ? "easy" : level <= 4 ? "medium" : "hard",
            durationMinutes: 5 + level * 3,
            fullscreen: false,
          }),
          category,
          level,
        ],
      );
      return { data: rows[0] };
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
            "SELECT id,title,config,batch,opens_at,closes_at,jsonb_array_length(questions)::int count FROM student.assessments WHERE kind='assigned' AND code_hash=$1 AND published AND (batch IS NULL OR batch=$2) AND opens_at<=now() AND closes_at>now()",
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
      return {
        data: {
          ...attempt,
          title: assessment.title,
          kind: assessment.kind,
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
        kind: z.enum([
          "tab-hidden",
          "fullscreen-exit",
          "clipboard",
          "inactive",
        ]),
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
      if (attempt.status !== "active")
        return { data: { events: attempt.integrity.length } };
      const events = [
        ...attempt.integrity,
        { ...input, at: new Date().toISOString() },
      ].slice(-200);
      await client.query(
        "UPDATE student.attempts SET integrity=$2 WHERE id=$1",
        [attempt.id, JSON.stringify(events)],
      );
      return { data: { events: events.length } };
    });
  });
}
