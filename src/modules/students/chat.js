import { z } from "zod";
import { runStudent, owned } from "./context.js";
import { httpError } from "../../platform/http/errors.js";
const responseSchema = z
  .object({
    text: z.string().min(1).max(20000),
    card: z
      .object({
        type: z.enum([
          "opportunity",
          "recruiter",
          "portfolio",
          "what-if",
          "skills",
          "roadmap",
          "risks",
          "kpi",
        ]),
        title: z.string(),
        summary: z.string(),
        score: z.number().min(0).max(100).nullable(),
        items: z
          .array(
            z.object({
              label: z.string(),
              description: z.string(),
              status: z.string(),
            }),
          )
          .max(12),
        actions: z.array(z.string()).max(5),
      })
      .nullable(),
  })
  .strict();
export function registerChatRoutes(api, { pool, generate }) {
  api.get("/student/conversations", async (req) =>
    runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          "SELECT id,title,updated_at FROM student.conversations WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT 100",
          [req.actor.id],
        )
      ).rows,
    })),
  );
  api.post("/student/conversations", async (req) => {
    const input = z
      .object({
        title: z.string().min(1).max(120).default("New conversation"),
        jd: z.string().max(20000).default(""),
      })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          "INSERT INTO student.conversations(user_id,title,context) VALUES($1,$2,$3) RETURNING id,title",
          [req.actor.id, input.title, JSON.stringify({ jd: input.jd })],
        )
      ).rows[0],
    }));
  });
  api.get("/student/conversations/:id", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      const conversation = await owned(
        client,
        "conversations",
        z.uuid().parse(req.params.id),
        req.actor.id,
      );
      return {
        data: {
          ...conversation,
          messages: (
            await client.query(
              "SELECT id,role,content,card,sources,created_at FROM (SELECT * FROM student.messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 100) m ORDER BY id",
              [conversation.id],
            )
          ).rows,
        },
      };
    }),
  );
  api.post("/student/conversations/:id/delete", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      await client.query(
        "DELETE FROM student.conversations WHERE id=$1 AND user_id=$2",
        [z.uuid().parse(req.params.id), req.actor.id],
      );
      return { data: { deleted: true } };
    }),
  );
  api.post("/student/conversations/clear", async (req) => {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client) => {
      await client.query("DELETE FROM student.conversations WHERE user_id=$1", [
        req.actor.id,
      ]);
      return { data: { deleted: true } };
    });
  });
  api.post("/student/conversations/:id/message", async (req) => {
    const id = z.uuid().parse(req.params.id),
      input = z
        .object({
          message: z.string().trim().min(1).max(4000),
          documentId: z.uuid().optional(),
          resume: z.string().max(60000).optional(),
          jd: z.string().max(20000).optional(),
        })
        .strict()
        .parse(req.body);
    const context = await runStudent(
      pool,
      req.actor.id,
      async (client, official) => {
        const conversation = await owned(
          client,
          "conversations",
          id,
          req.actor.id,
        );
        const count = Number(
          (
            await client.query(
              "SELECT count(*)::int n FROM student.messages WHERE conversation_id=$1",
              [id],
            )
          ).rows[0].n,
        );
        if (count >= 200)
          throw httpError(
            413,
            "CONVERSATION_FULL",
            "Start a new conversation to continue.",
          );
        const document = input.documentId
          ? await owned(client, "documents", input.documentId, req.actor.id)
          : null;
        const history = (
          await client.query(
            "SELECT role,content FROM student.messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 20",
            [id],
          )
        ).rows.reverse();
        const profile =
          (
            await client.query(
              "SELECT details FROM student.profiles WHERE user_id=$1",
              [req.actor.id],
            )
          ).rows[0]?.details || {};
        return {
          official: {
            program: official.course_name,
            department: official.department_name,
            cgpa: official.cgpa,
          },
          profile: {
            dreamRoles: profile.dreamRoles,
            specialization: profile.specialization,
            bio: profile.bio,
          },
          history: history.map(m=>({...m,content:m.content.slice(0,1500)})),
          attachment: (document?.content || "").slice(0,20000),
          resume: (input.resume || conversation.context.resume || "").slice(0,20000),
          jd: (input.jd || conversation.context.jd || "").slice(0,10000),
          message: input.message,
        };
      },
    );
    const answer = await generate(
      req.actor.id,
      "chat.reply",
      "Give useful career guidance grounded in this student's evidence. You may include one structured career card if useful. What-if scores must be explicitly called projections; omit unsupported scores. No invented external sources or official eligibility decisions.",
      context,
      responseSchema,
    );
    return runStudent(pool, req.actor.id, async (client) => {
      await owned(client, "conversations", id, req.actor.id, true);
      await client.query(
        "INSERT INTO student.messages(conversation_id,user_id,role,content,card) VALUES($1,$2,'user',$3,NULL),($1,$2,'assistant',$4,$5)",
        [
          id,
          req.actor.id,
          input.message,
          answer.text,
          answer.card ? JSON.stringify(answer.card) : null,
        ],
      );
      await client.query(
        "UPDATE student.conversations SET updated_at=now(),context=context||$2::jsonb WHERE id=$1",
        [
          id,
          JSON.stringify({
            ...(input.resume ? { resume: input.resume } : {}),
            ...(input.jd ? { jd: input.jd } : {}),
          }),
        ],
      );
      return { data: { ...answer, sources: [], conversationId: id } };
    });
  });
}
