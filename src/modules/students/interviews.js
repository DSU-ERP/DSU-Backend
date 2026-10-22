import { z } from "zod";
import { randomBytes } from "node:crypto";
import { runStudent, owned, activity } from "./context.js";
import { httpError } from "../../platform/http/errors.js";
import {
  checkAnswer,
  turnRedirect,
  REDIRECT_LIMIT,
} from "./interview-guardrails.js";
import { interviewPlanTask, interviewSections, INTERVIEW_EVALUATION_TASK, INTERVIEW_COACHING_TASK, normalizeInterviewFeedback } from "./interview-prompts.js";
const words = z.array(z.string().max(1500)).max(12);
const score = z.number().min(0).max(10);
// Every rubric dimension the AI scores for an answer, out of ten.
export const DIMENSIONS = [
  "relevance",
  "clarity",
  "confidence",
  "structure",
  "specificity",
  "roleFit",
  "communication",
  "depth",
  "conciseness",
  "accuracy",
  "overall",
];
// The report's headline scores. The dashboard and readiness views read these.
const SUMMARY = ["overall", "communication", "confidence", "accuracy"];
export const QUALITY = ["Poor", "Basic", "Good", "Strong", "Placement-ready"];
const STAR = ["situation", "task", "action", "result"];
export const feedbackSchema = z
  .object({
    scores: z
      .object(Object.fromEntries(DIMENSIONS.map((key) => [key, score])))
      .strict(),
    quality: z.enum(QUALITY),
    explanation: z.string().max(3000),
    strengths: words,
    improvements: words,
    followUp: z.string().max(1500).nullable(),
    turn: z
      .object({
        kind: z.enum([
          "answer",
          "partial",
          "off-topic",
          "clarification",
          "non-answer",
        ]),
        scored: z.boolean(),
        reason: z.string().max(500),
      })
      .strict(),
    star: z
      .object({
        applicable: z.boolean(),
        situation: z.boolean(),
        task: z.boolean(),
        action: z.boolean(),
        result: z.boolean(),
        missing: z
          .array(z.enum(["Situation", "Task", "Action", "Result"]))
          .max(4),
        score: score.nullable(),
        feedback: z.string().max(1000).nullable(),
      })
      .strict(),
  })
  .strict();
const question = z.object({
  question: z.string().min(5).max(2000),
  focus: z.string().max(100),
  expectedPoints: words,
});
// The AI's reading of the plan's documents. No alignment or fit score: the
// student sees what was read, not a number that looks like a hiring signal.
const planContext = z
  .object({
    jdSummary: z.string().max(1500),
    responsibilities: words,
    mustHaveSkills: words,
    resumeSummary: z.string().max(1500),
    strengths: words,
    risks: words,
    objective: z.string().max(600),
    sections: z
      .array(
        z
          .object({
            name: z.string().max(100),
            description: z.string().max(400),
            questionCount: z.number().int().min(0).max(15),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();
const configSchema = z
  .object({
    durationMinutes: z.number().int().min(5).max(60),
    language: z.enum(["en-IN", "en-US", "en-GB"]),
    tone: z.enum(["confident", "friendly", "strict"]),
    depth: z.enum(["moderate", "deep"]),
    questionCount: z.number().int().min(3).max(15),
    preferredMode: z.enum(["mock", "proctored"]).optional(),
    channels: z.object({ text: z.boolean(), voice: z.boolean(), video: z.boolean() }).strict().optional(),
  })
  .strict()
  .refine((value) => !value.channels || value.channels.text || value.channels.voice, "Enable text or voice answers.")
  .refine((value) => value.preferredMode !== "proctored" || !value.channels || value.channels.voice && value.channels.video, "Proctored practice requires voice and camera.");
// Follow-ups per session: one per main question at most, and no more than this.
export const FOLLOW_UP_LIMIT = { moderate: 2, deep: 4 };
const EXCERPT = 8000;
const excerpt = (text) => String(text || "").slice(0, EXCERPT);
// Legacy feedback has no turn judgement; it was always a scored answer.
export const isScored = (feedback) =>
  !!feedback?.scores && feedback.turn?.scored !== false;
const isUnscored = (feedback) =>
  !!feedback?.scores && feedback.turn?.scored === false;
const isFollowUp = (item) => Number.isInteger(item?.parent);
function average(items, pick) {
  const values = items
    .map(pick)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
    : null;
}
// The first question still waiting for an answer. A question the interviewer
// redirected after an unscored turn ("reask") stays current until re-answered.
export function currentIndex(questions, answers) {
  const saved = new Set(answers.map((answer) => answer.question_index));
  return questions.findIndex((item, index) => item.reask || !saved.has(index));
}
// What the student sees while follow-ups are inserted: main questions are
// numbered 1..planned and a follow-up carries its parent's number, so a
// follow-up never shifts "Question 2 of 3" to "Question 3 of 4". Answers to
// re-asked questions are not counted until the question is answered again.
export function progress(questions, answers, index) {
  const numbers = [];
  let planned = 0;
  questions.forEach((item, position) => {
    numbers[position] = isFollowUp(item) ? numbers[item.parent] : ++planned;
  });
  const current = index < 0 ? null : questions[index];
  return {
    plannedCount: planned,
    currentNumber: current ? (numbers[index] ?? null) : null,
    answeredCount: answers.filter(
      (answer) => !questions[answer.question_index]?.reask,
    ).length,
  };
}
export function makeReport(answers) {
  const evaluated = answers.filter((answer) => answer.feedback?.scores);
  const graded = evaluated.filter((answer) => isScored(answer.feedback));
  const star = graded.filter((answer) => answer.feedback.star?.applicable);
  const unique = (pick) => [...new Set(graded.flatMap(pick))];
  return {
    scores: Object.fromEntries(
      SUMMARY.map((key) => [
        key,
        average(graded, (answer) => answer.feedback.scores[key]),
      ]),
    ),
    dimensions: Object.fromEntries(
      DIMENSIONS.map((key) => [
        key,
        average(graded, (answer) => answer.feedback.scores[key]),
      ]),
    ),
    qualities: graded.reduce((counts, answer) => {
      const level = answer.feedback.quality;
      if (typeof level === "string") counts[level] = (counts[level] || 0) + 1;
      return counts;
    }, {}),
    answered: answers.length,
    graded: graded.length,
    unscored: evaluated.length - graded.length,
    pending: answers.length - evaluated.length,
    star: star.length
      ? {
          answers: star.length,
          complete: star.filter((answer) =>
            STAR.every((key) => answer.feedback.star[key] === true),
          ).length,
          elements: Object.fromEntries(
            STAR.map((key) => [
              key,
              star.filter((answer) => answer.feedback.star[key] === true)
                .length,
            ]),
          ),
          score: average(star, (answer) => answer.feedback.star.score),
        }
      : null,
    strengths: unique((answer) => answer.feedback.strengths || []).slice(0, 6),
    improvements: unique((answer) => answer.feedback.improvements || []).slice(
      0,
      6,
    ),
    nextPlan: unique((answer) => answer.feedback.improvements || []).slice(
      0,
      4,
    ),
    basis:
      "AI assessment of answer text using the interview rubric. Only answers the interviewer scored are averaged; clarification requests and off-topic turns are listed but not scored. Confidence is a language/delivery estimate, not biometric or acoustic measurement.",
  };
}
// Moderate depth follows up only when the answer is missing evidence; deep
// depth may also probe a complete answer. Both stay within FOLLOW_UP_LIMIT.
export function followUpNeeded(feedback, depth) {
  if (!isScored(feedback) || !feedback.followUp?.trim()) return false;
  if (depth === "deep") return true;
  const scores = feedback.scores || {};
  return (
    feedback.turn?.kind === "partial" ||
    (feedback.star?.applicable === true && feedback.star.missing?.length > 0) ||
    ["relevance", "specificity", "depth"].some(
      (key) => typeof scores[key] === "number" && scores[key] < 6,
    )
  );
}
function evaluationInput(session, plan, index, answer, parentAnswer = null) {
  const item = session.questions[index];
  const parent = isFollowUp(item) ? session.questions[item.parent] : null;
  return {
    question: {
      question: item.question,
      focus: item.focus,
      expectedPoints: item.expectedPoints || [],
      isFollowUp: !!parent,
      parentQuestion: parent?.question ?? null,
      parentAnswer,
    },
    answer,
    role: plan.config.role || "",
    company: plan.config.company || "",
    config: {
      language: plan.config.language,
      tone: plan.config.tone,
      depth: plan.config.depth,
      keywords: plan.config.keywords || [],
    },
    goal: plan.goal,
    jd: excerpt(plan.jd),
    resume: excerpt(plan.resume_context),
  };
}
const evaluate = async (generate, pool, actor, session, plan, index, answer) => {
  const item = session.questions[index];
  const parentAnswer = isFollowUp(item) ? await runStudent(pool, actor, async (client) =>
    (await client.query("SELECT answer FROM student.interview_answers WHERE session_id=$1 AND question_index=$2", [session.id, item.parent])).rows[0]?.answer || null,
  ) : null;
  const feedback = await generate(
    actor,
    "interview.evaluate",
    INTERVIEW_EVALUATION_TASK,
    evaluationInput(session, plan, index, answer, parentAnswer),
    feedbackSchema,
  );
  return normalizeInterviewFeedback(feedback, { isFollowUp: isFollowUp(item), question: item.question });
};
// Server-assigned severity. Only warnings count toward the three-strike end;
// information events are recorded for the report but never end a session.
export const INTEGRITY_SEVERITY = {
  "tab-hidden": "warning",
  "focus-lost": "warning",
  "fullscreen-exit": "warning",
  "screen-stopped": "warning",
  "camera-stopped": "warning",
  "mic-stopped": "warning",
  clipboard: "warning",
  "context-menu": "warning",
  "drag-drop": "warning",
  "navigation-attempt": "warning",
  "restricted-window": "warning",
  "picture-in-picture": "warning",
  inactive: "info",
  "extended-display": "warning",
};
const INFO_EVENT_LIMIT = 20;
export const strikes = (events) =>
  events.filter((event) => (event.severity || INTEGRITY_SEVERITY[event.kind]) === "warning").length;
const COACHING_ACTIONS = [
  "Ideal Answer",
  "Improve My Answer",
  "STAR Version",
  "Concise Version",
  "Placement-Ready",
  "Recruiter Expectations",
  "Mistake Breakdown",
];
const coachingSchema = z
  .object({
    title: z.string(),
    explanation: z.string(),
    points: words,
    rewrite: z.string().nullable(),
    why: z.string(),
    nextTip: z.string(),
  })
  .strict();
async function finalize(client, actor, session, reason = null) {
  const answers = (
    await client.query(
      "SELECT * FROM student.interview_answers WHERE session_id=$1 ORDER BY question_index",
      [session.id],
    )
  ).rows;
  const report = makeReport(answers);
  await client.query(
    "UPDATE student.interview_sessions SET status=$2,ended_at=coalesce(ended_at,least(now(),expires_at)),report=$3,termination_reason=$4 WHERE id=$1",
    [
      session.id,
      reason ? "terminated" : "completed",
      JSON.stringify(report),
      reason,
    ],
  );
  if (session.status === "active")
    await activity(client, actor, "interview.completed", session.id);
  return report;
}
export function registerInterviewRoutes(api, { pool, generate }) {
  api.get("/student/interviews", async (req) => {
    const q = z
      .object({
        search: z.string().max(100).default(""),
        from: z.iso.datetime({ offset: true }).optional(),
        archived: z.enum(["true", "false"]).default("false"),
      })
      .strict()
      .parse(req.query);
    return runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          `SELECT i.id,i.title,i.goal,i.config,i.created_at,i.archived,jsonb_array_length(i.questions) questions,
      (SELECT count(*)::int FROM student.interview_sessions s WHERE s.interview_id=i.id AND s.status='completed') sessions,
      (SELECT coalesce(sum(extract(epoch FROM ended_at-started_at)),0)::int FROM student.interview_sessions s WHERE s.interview_id=i.id AND s.status<>'active') seconds
      FROM student.interviews i WHERE user_id=$1 AND archived=$2 AND strpos(lower(title||' '||goal),lower($3))>0 AND ($4::timestamptz IS NULL OR created_at>=$4) ORDER BY created_at DESC,id LIMIT 100`,
          [req.actor.id, q.archived === "true", q.search, q.from || null],
        )
      ).rows,
    }));
  });
  api.get("/student/interview-sessions", async (req) => {
    const input = z.object({ search: z.string().max(100).default(""), status: z.enum(["all", "active", "completed", "terminated"]).default("all"), page: z.coerce.number().int().min(1).max(200).default(1) }).parse(req.query);
    return runStudent(pool, req.actor.id, async (client) => {
      const rows = (await client.query("SELECT s.id,s.interview_id,s.status,s.mode,s.started_at,s.ended_at,s.report,i.title FROM student.interview_sessions s JOIN student.interviews i ON i.id=s.interview_id WHERE s.user_id=$1 AND ($2='all' OR s.status=$2) AND strpos(lower(i.title),lower($3))>0 ORDER BY s.started_at DESC,s.id LIMIT 25 OFFSET $4", [req.actor.id, input.status, input.search, (input.page - 1) * 24])).rows;
      return { data: { rows: rows.slice(0, 24), page: input.page, hasMore: rows.length > 24 } };
    });
  });
  api.get("/student/interviews/stats", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      // Aggregate in one actor-scoped snapshot instead of eight network round trips.
      const data = (await client.query(`SELECT (SELECT to_jsonb(row) FROM (SELECT count(*)::int plans,coalesce(sum(jsonb_array_length(questions)),0)::int questions FROM student.interviews WHERE user_id=$1 AND NOT archived) row) AS "plans",
      (SELECT to_jsonb(row) FROM (SELECT count(*)::int total,count(*) FILTER(WHERE status='completed')::int completed,coalesce(sum(extract(epoch FROM ended_at-started_at)) FILTER(WHERE status<>'active'),0)::int seconds FROM student.interview_sessions WHERE user_id=$1) row) AS "sessions",
      (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT (started_at AT TIME ZONE 'Asia/Kolkata')::date::text AS activity_date,count(*)::int sessions,coalesce(sum(extract(epoch FROM ended_at-started_at)),0)::int seconds FROM student.interview_sessions WHERE user_id=$1 AND started_at>now()-interval '30 days' GROUP BY activity_date ORDER BY activity_date) row) AS "daily",
      (SELECT to_jsonb(row) FROM (SELECT count(*)::int total FROM student.interview_answers WHERE user_id=$1) row) AS "answers",
      (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT status,count(*)::int total FROM student.interview_sessions WHERE user_id=$1 GROUP BY status) row) AS "statuses",
      (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT coalesce(nullif(q->>'focus',''),'General') label,count(*)::int total FROM student.interviews i CROSS JOIN LATERAL jsonb_array_elements(i.questions) q WHERE i.user_id=$1 AND NOT i.archived GROUP BY label ORDER BY total DESC LIMIT 8) row) AS "focus",
      (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text activity_date,count(*)::int answers FROM student.interview_answers WHERE user_id=$1 AND created_at>now()-interval '30 days' GROUP BY activity_date ORDER BY activity_date) row) AS "answerDays",
      (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT s.id,s.status,s.mode,s.started_at,s.ended_at,s.report,i.title FROM student.interview_sessions s JOIN student.interviews i ON i.id=s.interview_id WHERE s.user_id=$1 ORDER BY s.started_at DESC LIMIT 10) row) AS "recent"`, [req.actor.id])).rows[0];
      return { data: { ...data, answers: data.answers.total } };
    }),
  );
  api.post("/student/interviews", async (req) => {
    const input = z
      .object({
        source: z.enum(["ai", "manual"]),
        goal: z.string().trim().min(10).max(3000),
        jd: z.string().max(20000).default(""),
        resume: z.string().max(60000).default(""),
        config: configSchema,
        manualQuestions: z
          .array(z.string().min(5).max(2000))
          .max(15)
          .default([]),
      })
      .strict()
      .parse(req.body);
    await runStudent(pool, req.actor.id, async () => {});
    let generated;
    if (input.source === "manual") {
      if (input.manualQuestions.length < 3)
        throw httpError(
          400,
          "QUESTIONS_REQUIRED",
          "Add at least three interview questions.",
        );
      generated = {
        title: input.goal.slice(0, 100),
        company: "",
        role: input.goal.slice(0, 100),
        keywords: [],
        questions: input.manualQuestions.map((text) => ({
          question: text,
          focus: "Student-created",
          expectedPoints: [],
        })),
        context: {},
      };
    } else {
      generated = await generate(
        req.actor.id,
        "interview.generate",
        interviewPlanTask(input.config),
        input,
        z
          .object({
            title: z.string().max(200),
            company: z.string().max(200),
            role: z.string().max(200),
            keywords: words,
            questions: z.array(question).length(input.config.questionCount),
            context: planContext,
          })
          .strict(),
      );
      const unique = new Set(generated.questions.map((item) => item.question.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
      if (unique.size !== input.config.questionCount)
        throw httpError(502, "AI_INVALID_RESPONSE", "The interview plan repeated a question. Please regenerate it; your draft is kept.");
      // Only documents the student supplied can be summarised.
      const jd = !!input.jd.trim(),
        resume = !!input.resume.trim();
      generated.context = {
        ...generated.context,
        sections: interviewSections(generated.questions, generated.context.sections),
        jdSummary: jd ? generated.context.jdSummary : "",
        responsibilities: jd ? generated.context.responsibilities : [],
        mustHaveSkills: jd ? generated.context.mustHaveSkills : [],
        resumeSummary: resume ? generated.context.resumeSummary : "",
        strengths: resume ? generated.context.strengths : [],
        risks: resume ? generated.context.risks : [],
        sources: { jd, resume },
      };
    }
    return runStudent(pool, req.actor.id, async (client) => {
      const { rows } = await client.query(
        "INSERT INTO student.interviews(user_id,title,goal,jd,resume_context,config,questions,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,title",
        [
          req.actor.id,
          generated.title,
          input.goal,
          input.jd,
          input.resume,
          JSON.stringify({
            ...input.config,
            company: generated.company,
            role: generated.role,
            keywords: generated.keywords,
          }),
          JSON.stringify(generated.questions),
          JSON.stringify(generated.context),
        ],
      );
      await activity(client, req.actor.id, "interview.created", rows[0].id);
      return { data: rows[0] };
    });
  });
  api.get("/student/interviews/:id", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      const plan = await owned(
        client,
        "interviews",
        z.uuid().parse(req.params.id),
        req.actor.id,
      );
      const sessions = (
        await client.query(
          "SELECT id,mode,status,started_at,ended_at,report FROM student.interview_sessions WHERE interview_id=$1 ORDER BY started_at DESC LIMIT 50",
          [plan.id],
        )
      ).rows;
      return {
        data: {
          ...plan,
          context: plan.context?.sections?.length ? { ...plan.context, sections: interviewSections(plan.questions, plan.context.sections) } : plan.context,
          questions: plan.questions.map((item) => ({ focus: item.focus })),
          sessions,
        },
      };
    }),
  );
  api.post("/student/interviews/:id/archive", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      const input = z
        .object({ archived: z.boolean() })
        .strict()
        .parse(req.body);
      await client.query(
        "UPDATE student.interviews SET archived=$3 WHERE id=$1 AND user_id=$2",
        [z.uuid().parse(req.params.id), req.actor.id, input.archived],
      );
      return { data: { archived: input.archived } };
    }),
  );
  api.post("/student/interviews/:id/sessions", async (req) => {
    const input = z
      .object({
        mode: z.enum(["mock", "proctored"]),
        accepted: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client) => {
      const plan = await owned(
        client,
        "interviews",
        z.uuid().parse(req.params.id),
        req.actor.id,
        true,
      );
      if (plan.archived)
        throw httpError(
          409,
          "ARCHIVED",
          "Restore the interview before starting a session.",
        );
      const active = (
        await client.query(
          "SELECT * FROM student.interview_sessions WHERE interview_id=$1 AND user_id=$2 AND status='active' ORDER BY started_at DESC LIMIT 1",
          [plan.id, req.actor.id],
        )
      ).rows[0];
      if (active && Date.parse(active.expires_at) > Date.now())
        return { data: { id: active.id, resumed: true } };
      if (active) await finalize(client, req.actor.id, active);
      return {
        data: (
          await client.query(
            "INSERT INTO student.interview_sessions(user_id,interview_id,mode,expires_at,questions) VALUES($1,$2,$3,now()+make_interval(mins=>$4),$5) RETURNING id",
            [
              req.actor.id,
              plan.id,
              input.mode,
              plan.config.durationMinutes,
              JSON.stringify(plan.questions),
            ],
          )
        ).rows[0],
      };
    });
  });
  api.get("/student/sessions/:id", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      let session = await owned(
        client,
        "interview_sessions",
        z.uuid().parse(req.params.id),
        req.actor.id,
        true,
      );
      if (
        session.status === "active" &&
        Date.parse(session.expires_at) <= Date.now()
      ) {
        await finalize(client, req.actor.id, session);
        session = await owned(
          client,
          "interview_sessions",
          session.id,
          req.actor.id,
        );
      }
      const plan = await owned(
          client,
          "interviews",
          session.interview_id,
          req.actor.id,
        ),
        answers = (
          await client.query(
            "SELECT * FROM student.interview_answers WHERE session_id=$1 ORDER BY question_index",
            [session.id],
          )
        ).rows;
      const nextIndex = currentIndex(session.questions, answers);
      const hidden =
        session.mode === "proctored" && session.status === "active";
      const current = nextIndex < 0 ? null : session.questions[nextIndex];
      return {
        data: {
          ...session,
          title: plan.title,
          config: plan.config,
          questions:
            session.status === "active"
              ? undefined
              : session.questions.map((item) => ({
                  question: item.question,
                  focus: item.focus,
                  parent: isFollowUp(item) ? item.parent : null,
                })),
          questionCount: session.questions.length,
          currentIndex: nextIndex,
          currentQuestion: current?.question ?? null,
          currentFocus: current?.focus ?? null,
          currentIsFollowUp: isFollowUp(current),
          currentParent: isFollowUp(current) ? current.parent : null,
          // Students can see their own conversation in both modes. Proctored
          // sessions still withhold scoring, coaching and private guidance.
          answers: answers.map((a) => ({
                ...(hidden ? { id: a.id, question_index: a.question_index, answer: a.answer, feedback: {}, original_answer: a.original_answer, original_feedback: null, retried: a.retried } : a),
                question: session.questions[a.question_index]?.question,
                focus: session.questions[a.question_index]?.focus,
              })),
          report: hidden ? null : session.report,
          ...progress(session.questions, answers, nextIndex),
        },
      };
    }),
  );
  api.post("/student/sessions/:id/answer", async (req) => {
    const id = z.uuid().parse(req.params.id),
      input = z
        .object({
          questionIndex: z.number().int().min(0).max(40),
          // "56" or "Yes" can completely answer a question; the guardrails
          // and the evaluator judge whether a turn is an answer.
          answer: z.string().trim().min(1).max(12000),
          retry: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
    const context = await runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
          client,
          "interview_sessions",
          id,
          req.actor.id,
          true,
        ),
        plan = await owned(
          client,
          "interviews",
          session.interview_id,
          req.actor.id,
        );
      if (
        session.status !== "active" ||
        Date.parse(session.expires_at) <= Date.now()
      )
        throw httpError(
          409,
          "SESSION_ENDED",
          "This session has ended. Open its report.",
        );
      const existing = (
        await client.query(
          "SELECT * FROM student.interview_answers WHERE session_id=$1 AND question_index=$2",
          [id, input.questionIndex],
        )
      ).rows[0];
      const pendingRetry =
        input.retry &&
        existing?.retried &&
        !existing.feedback?.scores &&
        existing.answer === input.answer;
      if (!existing) {
        const saved = (
          await client.query(
            "SELECT question_index FROM student.interview_answers WHERE session_id=$1",
            [id],
          )
        ).rows;
        if (
          input.retry ||
          input.questionIndex !== currentIndex(session.questions, saved)
        )
          throw httpError(
            409,
            "QUESTION_ORDER",
            "Answer the current interview question first.",
          );
      }
      // The practice retry improves a scored answer; an unscored or
      // unevaluated turn is answered again (or re-evaluated) instead.
      if (
        input.retry &&
        !pendingRetry &&
        (session.mode !== "mock" ||
          existing?.retried ||
          !isScored(existing?.feedback))
      )
        throw httpError(
          409,
          "RETRY_UNAVAILABLE",
          "One practice retry is available in mock mode only.",
        );
      const item = session.questions[input.questionIndex];
      if (!item)
        throw httpError(
          400,
          "INVALID_QUESTION",
          "Choose an available question.",
        );
      // An unscored turn the interviewer redirected may be answered again.
      const replacing =
        !!existing && isUnscored(existing.feedback) && !!item.reask;
      if (
        existing &&
        !input.retry &&
        existing.answer !== input.answer &&
        !replacing
      )
        throw httpError(
          409,
          "ANSWER_SAVED",
          "This answer is already saved. Use the practice retry if available.",
        );
      const redirects = item.redirects || 0;
      if (
        (!existing || existing.answer !== input.answer) &&
        redirects < REDIRECT_LIMIT
      ) {
        const issue = checkAnswer(input.answer);
        if (issue) {
          const questions = [...session.questions];
          questions[input.questionIndex] = {
            ...item,
            redirects: redirects + 1,
          };
          await client.query(
            "UPDATE student.interview_sessions SET questions=$2 WHERE id=$1",
            [id, JSON.stringify(questions)],
          );
          return {
            redirect: issue,
            remaining: REDIRECT_LIMIT - redirects - 1,
          };
        }
      }
      if (
        existing?.feedback?.scores &&
        !input.retry &&
        existing.answer === input.answer
      )
        return { session, plan, cached: existing.feedback, item };
      await client.query(
        `INSERT INTO student.interview_answers(user_id,session_id,question_index,answer,feedback) VALUES($1,$2,$3,$4,'{}')
        ON CONFLICT(session_id,question_index) DO UPDATE SET original_answer=CASE WHEN $5 THEN student.interview_answers.answer ELSE student.interview_answers.original_answer END,
        original_feedback=CASE WHEN $5 THEN student.interview_answers.feedback ELSE student.interview_answers.original_feedback END,answer=$4,feedback='{}',coaching='{}',retried=student.interview_answers.retried OR $5`,
        [
          req.actor.id,
          id,
          input.questionIndex,
          input.answer,
          input.retry && !pendingRetry,
        ],
      );
      // A saved answer settles the question until its evaluation says otherwise.
      if (item.reask) {
        const questions = [...session.questions];
        const { reask: _settled, ...rest } = item;
        questions[input.questionIndex] = rest;
        await client.query(
          "UPDATE student.interview_sessions SET questions=$2 WHERE id=$1",
          [id, JSON.stringify(questions)],
        );
      }
      return { session, plan, item };
    });
    if (context.redirect)
      return {
        data: {
          saved: false,
          feedback: null,
          redirect: context.redirect,
          redirectsRemaining: context.remaining,
          followUp: null,
        },
      };
    const feedback =
      context.cached ||
      (await evaluate(
        generate,
        pool,
        req.actor.id,
        context.session,
        context.plan,
        input.questionIndex,
        input.answer,
      ));
    return runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        id,
        req.actor.id,
        true,
      );
      const index = input.questionIndex,
        depth = context.plan.config.depth;
      let redirect = null,
        followUp = null;
      const stored = context.cached
        ? false
        : (
            await client.query(
              "UPDATE student.interview_answers SET feedback=$3 WHERE session_id=$1 AND question_index=$2 AND answer=$4 RETURNING id",
              [id, index, JSON.stringify(feedback), input.answer],
            )
          ).rows.length > 0;
      const item = session.questions[index];
      if (context.cached && isUnscored(feedback) && item?.reask)
        redirect = turnRedirect(feedback.turn.kind);
      // Later answers (another tab) mean the conversation has moved on, and
      // nothing is re-asked or followed up once the server timer has run out.
      const settled =
        stored &&
        item &&
        session.status === "active" &&
        Date.parse(session.expires_at) > Date.now() &&
        !input.retry &&
        !(
          await client.query(
            "SELECT 1 FROM student.interview_answers WHERE session_id=$1 AND question_index>$2 LIMIT 1",
            [id, index],
          )
        ).rows.length;
      if (settled) {
        const questions = [...session.questions];
        if (isUnscored(feedback) && (item.redirects || 0) < REDIRECT_LIMIT) {
          // Keep the same question: the interviewer redirects and the
          // student's next attempt replaces this unscored turn.
          questions[index] = {
            ...item,
            redirects: (item.redirects || 0) + 1,
            reask: true,
          };
          redirect = turnRedirect(feedback.turn.kind);
        } else if (
          !isFollowUp(item) &&
          !questions.some((other) => other.parent === index) &&
          questions.filter(isFollowUp).length <
            (FOLLOW_UP_LIMIT[depth] ?? FOLLOW_UP_LIMIT.moderate) &&
          followUpNeeded(feedback, depth)
        ) {
          // The follow-up is asked next, straight after its main question.
          questions.splice(index + 1, 0, {
            question: feedback.followUp.trim(),
            focus: "Follow-up",
            expectedPoints: [],
            parent: index,
          });
          followUp = { questionIndex: index + 1 };
        }
        if (redirect || followUp)
          await client.query(
            "UPDATE student.interview_sessions SET questions=$2 WHERE id=$1",
            [id, JSON.stringify(questions)],
          );
      }
      if (session.status !== "active")
        await finalize(
          client,
          req.actor.id,
          session,
          session.termination_reason,
        );
      return {
        data: {
          saved: true,
          feedback:
            session.mode === "proctored" && session.status === "active"
              ? null
              : feedback,
          redirect,
          followUp,
        },
      };
    });
  });
  api.post("/student/sessions/:id/evaluate", async (req) => {
    const id = z.uuid().parse(req.params.id);
    const context = await runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        id,
        req.actor.id,
      );
      if (session.status === "active")
        throw httpError(
          409,
          "FINISH_FIRST",
          "Finish the interview before retrying pending evaluations.",
        );
      const plan = await owned(
        client,
        "interviews",
        session.interview_id,
        req.actor.id,
      );
      const pending = (
        await client.query(
          "SELECT * FROM student.interview_answers WHERE session_id=$1 AND NOT (feedback ? 'scores') ORDER BY question_index LIMIT 1",
          [id],
        )
      ).rows;
      return { session, plan, pending };
    });
    for (const answer of context.pending) {
      const feedback = await evaluate(
        generate,
        pool,
        req.actor.id,
        context.session,
        context.plan,
        answer.question_index,
        answer.answer,
      );
      await runStudent(pool, req.actor.id, (client) =>
        client.query(
          "UPDATE student.interview_answers SET feedback=$3 WHERE id=$1 AND user_id=$2 AND NOT (feedback ? 'scores')",
          [answer.id, req.actor.id, JSON.stringify(feedback)],
        ),
      );
    }
    return runStudent(pool, req.actor.id, async (client) => ({
      data: {
        report: await finalize(
          client,
          req.actor.id,
          await owned(client, "interview_sessions", id, req.actor.id, true),
          context.session.termination_reason,
        ),
      },
    }));
  });
  api.post("/student/sessions/:id/finish", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        z.uuid().parse(req.params.id),
        req.actor.id,
        true,
      );
      return {
        data: {
          report:
            session.status === "active"
              ? await finalize(client, req.actor.id, session)
              : session.report,
        },
      };
    }),
  );
  api.post("/student/sessions/:id/integrity", async (req) => {
    const input = z
      .object({
        kind: z.enum(Object.keys(INTEGRITY_SEVERITY)),
        detail: z.string().max(200).default(""),
        incidentId: z.uuid().optional(),
      })
      .strict()
      .parse(req.body);
    const severity = INTEGRITY_SEVERITY[input.kind];
    return runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        z.uuid().parse(req.params.id),
        req.actor.id,
        true,
      );
      const unchanged = {
        warnings: strikes(session.integrity),
        ended: session.status !== "active",
        severity,
        recorded: false,
      };
      if (session.status !== "active")
        return { data: unchanged };
      if (input.incidentId && session.integrity.some(event => event.incidentId === input.incidentId))
        return { data: unchanged };
      // One incident reported twice within three seconds counts once, even
      // when another event (an information notice) was recorded in between.
      const recent = session.integrity.findLast(
        (event) => event.kind === input.kind,
      );
      if (
        (recent?.kind === input.kind &&
          Date.now() - Date.parse(recent.at) < 3000) ||
        (severity === "info" &&
          session.integrity.filter((event) => event.kind === input.kind)
            .length >= INFO_EVENT_LIMIT)
      )
        return { data: unchanged };
      const events = [
        ...session.integrity,
        { ...input, severity, at: new Date().toISOString() },
      ];
      const warnings = strikes(events);
      await client.query(
        "UPDATE student.interview_sessions SET integrity=$2 WHERE id=$1",
        [session.id, JSON.stringify(events.slice(-200))],
      );
      const ended = severity === "warning" && warnings >= 3;
      if (ended)
        await finalize(
          client,
          req.actor.id,
          session,
          "Session ended after three browser integrity warnings.",
        );
      return { data: { warnings, ended, severity, recorded: true } };
    });
  });
  api.post("/student/sessions/:id/coach", async (req) => {
    const input = z
      .object({
        questionIndex: z.number().int().min(0).max(40),
        action: z.enum(COACHING_ACTIONS),
        regenerate: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    const id = z.uuid().parse(req.params.id);
    const context = await runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        id,
        req.actor.id,
      );
      if (session.status === "active")
        throw httpError(
          403,
          "FINISH_FIRST",
          "Coaching is available after the session ends.",
        );
      const answer = (
        await client.query(
          "SELECT answer,feedback,coaching FROM student.interview_answers WHERE session_id=$1 AND question_index=$2",
          [session.id, input.questionIndex],
        )
      ).rows[0];
      if (!answer)
        throw httpError(
          404,
          "NO_TRANSCRIPT",
          "There is no saved answer for this question.",
        );
      const plan = await owned(
        client,
        "interviews",
        session.interview_id,
        req.actor.id,
      );
      return { session, plan, answer };
    });
    const cached = context.answer.coaching?.[input.action];
    if (cached && !input.regenerate)
      return { data: { ...cached, cached: true } };
    const item = context.session.questions[input.questionIndex];
    const result = await generate(
      req.actor.id,
      "interview.coach",
      INTERVIEW_COACHING_TASK,
      {
        action: input.action,
        question: item.question,
        focus: item.focus,
        expectedPoints: item.expectedPoints || [],
        isFollowUp: isFollowUp(item),
        answer: context.answer.answer,
        feedback: context.answer.feedback,
        goal: context.plan.goal,
        role: context.plan.config.role || "",
        company: context.plan.config.company || "",
        jd: excerpt(context.plan.jd),
        resume: excerpt(context.plan.resume_context),
      },
      coachingSchema,
    );
    const entry = { ...result, generatedAt: new Date().toISOString() };
    // Cache per coaching mode; the answer cannot change after the session ends.
    await runStudent(pool, req.actor.id, (client) =>
      client.query(
        "UPDATE student.interview_answers SET coaching=coaching||jsonb_build_object($3::text,$4::jsonb) WHERE session_id=$1 AND question_index=$2",
        [id, input.questionIndex, input.action, JSON.stringify(entry)],
      ),
    );
    return { data: { ...entry, cached: false } };
  });
  // Bandwidth probe for the interview room's network chip: incompressible
  // random bytes, never cached. Like every student route it needs a linked
  // student account, not just a signed-in user; no student data is read.
  api.get(
    "/student/netcheck",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { bytes } = z
        .object({
          bytes: z.coerce
            .number()
            .int()
            .min(1024)
            .max(200 * 1024)
            .default(64 * 1024),
        })
        .strict()
        .parse(req.query);
      await runStudent(pool, req.actor.id, async () => {});
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "no-store")
        .send(randomBytes(bytes));
    },
  );
}
