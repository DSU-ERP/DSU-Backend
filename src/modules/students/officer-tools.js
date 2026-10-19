import { z } from "zod";
import { withActor } from "../../integrations/supabase/db.js";
import {
  questionSchema,
  validateQuestions,
  codeHash,
  newClassCode,
} from "./assessments.js";
import { eventSchema } from "./calendar.js";
import { databaseError } from "../../platform/http/errors.js";
export function registerOfficerTools(api, { pool, env }) {
  const run = (req, fn) =>
    withActor(pool, req.actor.id, async (client) => {
      try {
        await client.query("SELECT public.dsu_placement_read('session','{}')");
      } catch (error) {
        throw databaseError(error);
      }
      return fn(client);
    });
  const broadcast = (client, actor, title, body, href, batch) =>
    client.query(
      "INSERT INTO student.broadcasts(creator_id,title,body,href,batch) VALUES($1,$2,$3,$4,$5)",
      [actor, title, body, href, batch],
    );
  api.get("/placement/tools/assessments", async (req) =>
    run(req, async (client) => ({
      data: (
        await client.query(
          "SELECT id,title,config,batch,opens_at,closes_at,published,created_at FROM student.assessments WHERE kind='assigned' ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    })),
  );
  api.post("/placement/tools/assessments/:id/publication", async (req) => {
    const { published } = z
      .object({ published: z.boolean() })
      .strict()
      .parse(req.body);
    return run(req, async (client) => ({
      data:
        (
          await client.query(
            "UPDATE student.assessments SET published=$2 WHERE id=$1 AND kind='assigned' RETURNING id,published",
            [z.uuid().parse(req.params.id), published],
          )
        ).rows[0] || null,
    }));
  });
  api.post("/placement/tools/assessments/:id/code", async (req) =>
    run(req, async (client) => {
      const code = newClassCode();
      const row = (
        await client.query(
          "UPDATE student.assessments SET code_hash=$2 WHERE id=$1 AND kind='assigned' RETURNING id",
          [
            z.uuid().parse(req.params.id),
            codeHash(code, env.ASSESSMENT_CODE_SECRET || env.SERVICE_TOKEN),
          ],
        )
      ).rows[0];
      return { data: row ? { ...row, code } : null };
    }),
  );
  api.get("/placement/tools/events", async (req) =>
    run(req, async (client) => ({
      data: (
        await client.query(
          "SELECT id,title,kind,batch,starts_at,ends_at,location FROM student.calendar_events WHERE user_id IS NULL ORDER BY starts_at DESC LIMIT 100",
        )
      ).rows,
    })),
  );
  api.get("/placement/tools/notices", async (req) =>
    run(req, async (client) => ({
      data: (
        await client.query(
          "SELECT id,title,body,batch,href,created_at FROM student.broadcasts ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    })),
  );
  api.post("/placement/tools/assessments", async (req) => {
    const input = z
      .object({
        title: z.string().trim().min(3).max(200),
        className: z.string().max(200),
        portions: z.string().max(2000),
        questions: z.array(questionSchema).min(1).max(50),
        batch: z.string().regex(/^20\d{2}$/),
        opensAt: z.iso.datetime({ offset: true }),
        closesAt: z.iso.datetime({ offset: true }),
        durationMinutes: z.number().int().min(5).max(180),
        proctored: z.boolean(),
        published: z.boolean(),
      })
      .strict()
      .refine((value) => Date.parse(value.closesAt) > Date.parse(value.opensAt))
      .parse(req.body);
    const questions = validateQuestions(input.questions),
      code = newClassCode();
    return run(req, async (client) => {
      const { rows } = await client.query(
        "INSERT INTO student.assessments(creator_id,kind,title,questions,config,batch,code_hash,opens_at,closes_at,published) VALUES($1,'assigned',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
        [
          req.actor.id,
          input.title,
          JSON.stringify(questions),
          JSON.stringify({
            className: input.className,
            portions: input.portions,
            durationMinutes: input.durationMinutes,
            fullscreen: input.proctored,
            difficulty: "assigned",
            allowRetake: false,
          }),
          input.batch,
          codeHash(code, env.ASSESSMENT_CODE_SECRET || env.SERVICE_TOKEN),
          input.opensAt,
          input.closesAt,
          input.published,
        ],
      );
      if (input.published)
        await broadcast(
          client,
          req.actor.id,
          input.title,
          `An assigned assessment is available for batch ${input.batch}. Obtain its class code from your placement office.`,
          "/student/assessments/faculty-test",
          input.batch,
        );
      return { data: { ...rows[0], code } };
    });
  });
  api.get("/placement/tools/assessments/:id/results", async (req) =>
    run(req, async (client) => ({
      data: (
        await client.query(
          "SELECT a.id,a.identity,a.status,a.started_at,a.submitted_at,a.result,a.integrity FROM student.attempts a JOIN student.assessments t ON t.id=a.assessment_id WHERE t.kind='assigned' AND t.id=$1 ORDER BY a.started_at DESC LIMIT 100",
          [z.uuid().parse(req.params.id)],
        )
      ).rows,
    })),
  );
  api.post("/placement/tools/events", async (req) => {
    const input = z
        .object({
          event: eventSchema,
          batch: z.string().regex(/^20\d{2}$/),
          notify: z.boolean(),
        })
        .strict()
        .parse(req.body),
      event = input.event;
    return run(req, async (client) => {
      const { rows } = await client.query(
        "INSERT INTO student.calendar_events(created_by,batch,title,kind,starts_at,ends_at,location,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [
          req.actor.id,
          input.batch,
          event.title,
          event.kind,
          event.startsAt,
          event.endsAt,
          event.location,
          event.description,
        ],
      );
      if (input.notify)
        await broadcast(
          client,
          req.actor.id,
          event.title,
          event.description || `New ${event.kind} event on your calendar.`,
          "/student/timetable",
          input.batch,
        );
      return { data: rows[0] };
    });
  });
  api.post("/placement/tools/notices", async (req) => {
    const input = z
      .object({
        title: z.string().trim().min(2).max(200),
        body: z.string().max(3000),
        batch: z.string().regex(/^20\d{2}$/),
        href: z
          .string()
          .regex(/^\/student(?:\/[a-z0-9/?=&.-]*)?$/)
          .max(500)
          .default("/student/dashboard"),
      })
      .strict()
      .parse(req.body);
    return run(req, async (client) => {
      await broadcast(
        client,
        req.actor.id,
        input.title,
        input.body,
        input.href,
        input.batch,
      );
      return { data: { published: true } };
    });
  });
}
