import { createHash } from "node:crypto";
import { z } from "zod";
import { runStudent, activity } from "./context.js";
const words = z.array(z.string().max(1500)).max(20);
export const careerSchema = z
  .object({
    summary: z.string().max(5000),
    advice: z.string().max(3000),
    alignment: z.number().min(0).max(100).nullable(),
    atsHealth: z.number().min(0).max(100).nullable(),
    bestFit: z.string().max(200),
    signals: words,
    strengths: words,
    weaknesses: words,
    roadmap: z.array(z.object({ phase: z.string(), actions: words })).max(6),
    risks: z
      .array(
        z.object({
          title: z.string(),
          severity: z.enum(["low", "medium", "high"]),
          mitigation: z.string(),
        }),
      )
      .max(10),
    roles: z
      .array(
        z.object({
          title: z.string(),
          fit: z.number().min(0).max(100).nullable(),
          reason: z.string(),
        }),
      )
      .max(8),
    recommendations: words,
    missingKeywords: words,
    formattingIssues: words,
  })
  .strict();
export function registerCareerRoutes(api, { pool, generate }) {
  api.get("/student/career", async (req) =>
    runStudent(pool, req.actor.id, async (client) => ({
      data: {
        report:
          (
            await client.query(
              "SELECT id,target,content,created_at FROM student.reports WHERE user_id=$1 AND kind='career' ORDER BY created_at DESC LIMIT 1",
              [req.actor.id],
            )
          ).rows[0] || null,
        resume:
          (
            await client.query(
              "SELECT id,filename,content FROM student.documents WHERE user_id=$1 AND kind='resume' ORDER BY created_at DESC LIMIT 1",
              [req.actor.id],
            )
          ).rows[0] || null,
      },
    })),
  );
  api.post("/student/career", async (req) => {
    const input = z
      .object({
        resume: z.string().trim().min(80).max(60000),
        target: z.string().trim().min(2).max(1000),
        consent: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const official = await runStudent(
      pool,
      req.actor.id,
      async (_client, record) => record,
    );
    const report = await generate(
      req.actor.id,
      "career.analyze",
      "Analyze this resume against the student's target. Provide evidence-based role suggestions, a practical roadmap, risks with mitigation and resume screening advice. State missing evidence. Alignment and ATS health are advisory estimates; use null when evidence does not support a score.",
      {
        resume: input.resume,
        target: input.target,
        academic: {
          program: official.course_name,
          cgpa: official.cgpa,
          department: official.department_name,
        },
      },
      careerSchema,
    );
    return runStudent(pool, req.actor.id, async (client) => {
      const { rows } = await client.query(
        "INSERT INTO student.reports(user_id,kind,target,content) VALUES($1,'career',$2,$3) RETURNING id,created_at",
        [req.actor.id, input.target, JSON.stringify(report)],
      );
      const hash = createHash("sha256").update(input.resume).digest("hex");
      await client.query(
        "INSERT INTO student.documents(user_id,filename,kind,content,sha256) SELECT $1,'Resume text','resume',$2,$3 WHERE NOT EXISTS(SELECT 1 FROM student.documents WHERE user_id=$1 AND kind='resume' AND sha256=$3)",
        [req.actor.id, input.resume, hash],
      );
      await activity(client, req.actor.id, "resume.analyzed", rows[0].id);
      return { data: { ...rows[0], content: report, target: input.target } };
    });
  });
  api.post("/student/readiness/plan", async (req) => {
    const context = await runStudent(
      pool,
      req.actor.id,
      async (client, official) => ({
        official,
        latest:
          (
            await client.query(
              "SELECT report FROM student.interview_sessions WHERE user_id=$1 AND status='completed' ORDER BY ended_at DESC LIMIT 1",
              [req.actor.id],
            )
          ).rows[0]?.report || null,
      }),
    );
    const schema = z.object({
      title: z.string(),
      actions: z
        .array(
          z.object({
            priority: z.number().int().min(1).max(5),
            title: z.string(),
            reason: z.string(),
            practice: z.string(),
          }),
        )
        .min(1)
        .max(5),
    });
    const plan = await generate(
      req.actor.id,
      "readiness.plan",
      "Create a prioritized preparation plan from the available interview feedback. If there is no completed interview, recommend a first baseline session without inventing skill scores.",
      context,
      schema,
    );
    await runStudent(pool, req.actor.id, (client) =>
      client.query(
        "INSERT INTO student.reports(user_id,kind,content) VALUES($1,'readiness-plan',$2)",
        [req.actor.id, JSON.stringify(plan)],
      ),
    );
    return { data: plan };
  });
}
