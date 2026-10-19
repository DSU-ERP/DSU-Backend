import { z } from "zod";
import { runStudent, owned, activity } from "./context.js";
import { httpError } from "../../platform/http/errors.js";
const words = z.array(z.string().max(1500)).max(12);
export const feedbackSchema = z
  .object({
    scores: z.object({
      overall: z.number().min(0).max(10),
      communication: z.number().min(0).max(10),
      confidence: z.number().min(0).max(10),
      accuracy: z.number().min(0).max(10),
    }),
    quality: z.enum(["Poor", "Basic", "Good", "Excellent"]),
    explanation: z.string().max(3000),
    strengths: words,
    improvements: words,
    followUp: z.string().max(1500).nullable(),
  })
  .strict();
const question = z.object({
  question: z.string().min(5).max(2000),
  focus: z.string().max(100),
  expectedPoints: words,
});
const configSchema = z
  .object({
    durationMinutes: z.number().int().min(5).max(60),
    language: z.enum(["en-IN", "en-US", "en-GB"]),
    tone: z.enum(["confident", "friendly", "strict"]),
    depth: z.enum(["moderate", "deep"]),
    questionCount: z.number().int().min(3).max(15),
  })
  .strict();
function makeReport(answers) {
  const graded = answers.filter((answer) => answer.feedback?.scores);
  const scores = Object.fromEntries(
    ["overall", "communication", "confidence", "accuracy"].map((key) => [
      key,
      graded.length
        ? Math.round(
            (graded.reduce(
              (total, answer) => total + answer.feedback.scores[key],
              0,
            ) /
              graded.length) *
              10,
          ) / 10
        : null,
    ]),
  );
  return {
    scores,
    answered: answers.length,
    graded: graded.length,
    pending: answers.length - graded.length,
    strengths: [
      ...new Set(graded.flatMap((answer) => answer.feedback.strengths)),
    ].slice(0, 6),
    improvements: [
      ...new Set(graded.flatMap((answer) => answer.feedback.improvements)),
    ].slice(0, 6),
    nextPlan: [
      ...new Set(graded.flatMap((answer) => answer.feedback.improvements)),
    ].slice(0, 4),
    basis:
      "AI assessment of answer text using the interview rubric. Confidence is a language/delivery estimate, not biometric or acoustic measurement.",
  };
}
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
  api.get("/student/interviews/stats", async (req) =>
    runStudent(pool, req.actor.id, async (client) => ({
      data: {
        plans: (
          await client.query(
            "SELECT count(*)::int plans,coalesce(sum(jsonb_array_length(questions)),0)::int questions FROM student.interviews WHERE user_id=$1 AND NOT archived",
            [req.actor.id],
          )
        ).rows[0],
        sessions: (
          await client.query(
            "SELECT count(*)::int total,count(*) FILTER(WHERE status='completed')::int completed,coalesce(sum(extract(epoch FROM ended_at-started_at)) FILTER(WHERE status<>'active'),0)::int seconds FROM student.interview_sessions WHERE user_id=$1",
            [req.actor.id],
          )
        ).rows[0],
        daily: (
          await client.query(
            "SELECT (started_at AT TIME ZONE 'Asia/Kolkata')::date::text AS activity_date,count(*)::int sessions,coalesce(sum(extract(epoch FROM ended_at-started_at)),0)::int seconds FROM student.interview_sessions WHERE user_id=$1 AND started_at>now()-interval '30 days' GROUP BY activity_date ORDER BY activity_date",
            [req.actor.id],
          )
        ).rows,
        answers: (
          await client.query(
            "SELECT count(*)::int total FROM student.interview_answers WHERE user_id=$1",
            [req.actor.id],
          )
        ).rows[0].total,
        statuses: (
          await client.query(
            "SELECT status,count(*)::int total FROM student.interview_sessions WHERE user_id=$1 GROUP BY status",
            [req.actor.id],
          )
        ).rows,
        focus: (
          await client.query(
            "SELECT coalesce(nullif(q->>'focus',''),'General') label,count(*)::int total FROM student.interviews i CROSS JOIN LATERAL jsonb_array_elements(i.questions) q WHERE i.user_id=$1 AND NOT i.archived GROUP BY label ORDER BY total DESC LIMIT 8",
            [req.actor.id],
          )
        ).rows,
        answerDays: (
          await client.query(
            "SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text activity_date,count(*)::int answers FROM student.interview_answers WHERE user_id=$1 AND created_at>now()-interval '30 days' GROUP BY activity_date ORDER BY activity_date",
            [req.actor.id],
          )
        ).rows,
        recent: (
          await client.query(
            "SELECT s.id,s.status,s.mode,s.started_at,s.ended_at,s.report,i.title FROM student.interview_sessions s JOIN student.interviews i ON i.id=s.interview_id WHERE s.user_id=$1 ORDER BY s.started_at DESC LIMIT 10",
            [req.actor.id],
          )
        ).rows,
      },
    })),
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
      };
    } else
      generated = await generate(
        req.actor.id,
        "interview.generate",
        `Create exactly ${input.config.questionCount} realistic questions tailored to the goal, JD and resume. Respect the requested language, tone and follow-up depth. Do not invent experience or a company. Include behavioral, role-specific and evidence-based questions.`,
        input,
        z
          .object({
            title: z.string().max(200),
            company: z.string().max(200),
            role: z.string().max(200),
            keywords: words,
            questions: z.array(question).length(input.config.questionCount),
          })
          .strict(),
      );
    return runStudent(pool, req.actor.id, async (client) => {
      const { rows } = await client.query(
        "INSERT INTO student.interviews(user_id,title,goal,jd,resume_context,config,questions) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title",
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
      const nextIndex = session.questions.findIndex(
        (_item, index) =>
          !answers.some((answer) => answer.question_index === index),
      );
      const hidden =
        session.mode === "proctored" && session.status === "active";
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
                })),
          questionCount: session.questions.length,
          currentIndex: nextIndex,
          currentQuestion:
            nextIndex < 0 ? null : session.questions[nextIndex].question,
          answers: hidden
            ? undefined
            : answers.map((a) => ({
                ...a,
                question: session.questions[a.question_index]?.question,
              })),
          report: hidden ? null : session.report,
          answeredCount: answers.length,
        },
      };
    }),
  );
  api.post("/student/sessions/:id/answer", async (req) => {
    const id = z.uuid().parse(req.params.id),
      input = z
        .object({
          questionIndex: z.number().int().min(0).max(20),
          answer: z.string().trim().min(5).max(12000),
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
        const next = session.questions.findIndex(
          (_q, index) => !saved.some((a) => a.question_index === index),
        );
        if (input.retry || input.questionIndex !== next)
          throw httpError(
            409,
            "QUESTION_ORDER",
            "Answer the current interview question first.",
          );
      }
      if (
        input.retry &&
        !pendingRetry &&
        (session.mode !== "mock" || existing?.retried)
      )
        throw httpError(
          409,
          "RETRY_UNAVAILABLE",
          "One practice retry is available in mock mode only.",
        );
      if (!session.questions[input.questionIndex])
        throw httpError(
          400,
          "INVALID_QUESTION",
          "Choose an available question.",
        );
      if (existing && !input.retry && existing.answer !== input.answer)
        throw httpError(
          409,
          "ANSWER_SAVED",
          "This answer is already saved. Use the practice retry if available.",
        );
      if (existing?.feedback?.scores && !input.retry)
        return { session, plan, cached: existing.feedback };
      await client.query(
        `INSERT INTO student.interview_answers(user_id,session_id,question_index,answer,feedback) VALUES($1,$2,$3,$4,'{}')
        ON CONFLICT(session_id,question_index) DO UPDATE SET original_answer=CASE WHEN $5 THEN student.interview_answers.answer ELSE student.interview_answers.original_answer END,
        original_feedback=CASE WHEN $5 THEN student.interview_answers.feedback ELSE student.interview_answers.original_feedback END,answer=$4,feedback='{}',retried=student.interview_answers.retried OR $5`,
        [
          req.actor.id,
          id,
          input.questionIndex,
          input.answer,
          input.retry && !pendingRetry,
        ],
      );
      return { session, plan };
    });
    const feedback =
      context.cached ||
      (await generate(
        req.actor.id,
        "interview.evaluate",
        "Evaluate this interview answer against its question and expected points. Score each rubric dimension out of ten. Give specific strengths and useful improvements. Confidence is inferred from text organization, not voice biometrics. Offer one natural follow-up only when it would deepen useful evidence.",
        {
          question: context.session.questions[input.questionIndex],
          answer: input.answer,
          config: context.plan.config,
          goal: context.plan.goal,
        },
        feedbackSchema,
      ));
    return runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        id,
        req.actor.id,
        true,
      );
      await client.query(
        "UPDATE student.interview_answers SET feedback=$3 WHERE session_id=$1 AND question_index=$2 AND answer=$4",
        [id, input.questionIndex, JSON.stringify(feedback), input.answer],
      );
      if (
        !context.cached &&
        !input.retry &&
        context.plan.config.depth === "deep" &&
        feedback.followUp &&
        session.questions.length < context.plan.questions.length + 2 &&
        session.status === "active"
      )
        await client.query(
          "UPDATE student.interview_sessions SET questions=questions||$2::jsonb WHERE id=$1",
          [
            id,
            JSON.stringify([
              {
                question: feedback.followUp,
                focus: "Follow-up",
                expectedPoints: [],
              },
            ]),
          ],
        );
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
          "SELECT * FROM student.interview_answers WHERE session_id=$1 AND NOT (feedback ? 'scores') ORDER BY question_index LIMIT 3",
          [id],
        )
      ).rows;
      return { session, plan, pending };
    });
    for (const answer of context.pending) {
      const feedback = await generate(
        req.actor.id,
        "interview.evaluate",
        "Evaluate the saved answer against the supplied question, expected points and config. Scores are text-based rubric estimates, not voice or biometric measurements.",
        {
          question: context.session.questions[answer.question_index],
          answer: answer.answer,
          config: context.plan.config,
          goal: context.plan.goal,
        },
        feedbackSchema,
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
        kind: z.enum([
          "tab-hidden",
          "focus-lost",
          "fullscreen-exit",
          "screen-stopped",
          "camera-stopped",
          "clipboard",
        ]),
        detail: z.string().max(200).default(""),
      })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        z.uuid().parse(req.params.id),
        req.actor.id,
        true,
      );
      if (session.mode !== "proctored" || session.status !== "active")
        return {
          data: {
            warnings: session.integrity.length,
            ended: session.status !== "active",
          },
        };
      const recent = session.integrity.at(-1);
      if (
        recent?.kind === input.kind &&
        Date.now() - Date.parse(recent.at) < 3000
      )
        return { data: { warnings: session.integrity.length, ended: false } };
      const events = [
        ...session.integrity,
        { ...input, at: new Date().toISOString() },
      ].slice(-200);
      await client.query(
        "UPDATE student.interview_sessions SET integrity=$2 WHERE id=$1",
        [session.id, JSON.stringify(events)],
      );
      if (events.length >= 3)
        await finalize(
          client,
          req.actor.id,
          session,
          "Session ended after three browser integrity warnings.",
        );
      return { data: { warnings: events.length, ended: events.length >= 3 } };
    });
  });
  api.post("/student/sessions/:id/coach", async (req) => {
    const input = z
      .object({
        questionIndex: z.number().int().min(0).max(20),
        action: z.enum([
          "Ideal Answer",
          "Improve My Answer",
          "STAR Version",
          "Concise Version",
          "Placement-Ready",
          "Recruiter Expectations",
          "Mistake Breakdown",
        ]),
      })
      .strict()
      .parse(req.body);
    const context = await runStudent(pool, req.actor.id, async (client) => {
      const session = await owned(
        client,
        "interview_sessions",
        z.uuid().parse(req.params.id),
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
          "SELECT answer,feedback FROM student.interview_answers WHERE session_id=$1 AND question_index=$2",
          [session.id, input.questionIndex],
        )
      ).rows[0];
      if (!answer)
        throw httpError(
          404,
          "NO_TRANSCRIPT",
          "There is no saved answer for this question.",
        );
      return {
        question: session.questions[input.questionIndex].question,
        ...answer,
        action: input.action,
      };
    });
    return {
      data: await generate(
        req.actor.id,
        "interview.coach",
        "Coach the selected answer using the requested action. Preserve the student's actual evidence and avoid inventing experience. Make any ideal example explicitly hypothetical.",
        context,
        z
          .object({
            title: z.string(),
            explanation: z.string(),
            points: words,
            rewrite: z.string().nullable(),
            why: z.string(),
            nextTip: z.string(),
          })
          .strict(),
      ),
    };
  });
}
