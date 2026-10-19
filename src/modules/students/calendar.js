import { z } from "zod";
import { runStudent, activity } from "./context.js";
export const eventSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    kind: z.enum([
      "class",
      "interview",
      "practice",
      "deadline",
      "mentoring",
      "other",
    ]),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    location: z.string().max(200).default(""),
    description: z.string().max(3000).default(""),
  })
  .refine(
    (value) =>
      Date.parse(value.endsAt) > Date.parse(value.startsAt) &&
      Date.parse(value.endsAt) - Date.parse(value.startsAt) <= 86400000,
    "Choose an end time after the start, within 24 hours.",
  );
export function registerCalendarRoutes(api, { pool }) {
  api.get("/student/calendar", async (req) => {
    const q = z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(req.query);
    return runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          "SELECT id,title,kind,starts_at,ends_at,location,description,user_id FROM student.calendar_events WHERE starts_at>=coalesce($1::timestamptz,now()-interval '7 days') AND starts_at<coalesce($2::timestamptz,now()+interval '30 days') ORDER BY starts_at LIMIT 250",
          [q.from || null, q.to || null],
        )
      ).rows,
    }));
  });
  api.post("/student/calendar", async (req) => {
    const input = eventSchema.parse(req.body);
    return runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          "INSERT INTO student.calendar_events(user_id,created_by,title,kind,starts_at,ends_at,location,description) VALUES($1,$1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [
            req.actor.id,
            input.title,
            input.kind,
            input.startsAt,
            input.endsAt,
            input.location,
            input.description,
          ],
        )
      ).rows[0],
    }));
  });
  api.post("/student/calendar/:id/delete", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      await client.query(
        "DELETE FROM student.calendar_events WHERE id=$1 AND user_id=$2",
        [z.uuid().parse(req.params.id), req.actor.id],
      );
      return { data: { deleted: true } };
    }),
  );
  api.get("/student/notifications", async (req) =>
    runStudent(pool, req.actor.id, async (client) => ({
      data: (
        await client.query(
          `SELECT * FROM (
    SELECT id,title,body,href,read_at,created_at FROM student.notifications WHERE user_id=$1
    UNION ALL SELECT b.id,b.title,b.body,b.href,r.read_at,b.created_at FROM student.broadcasts b LEFT JOIN student.notice_reads r ON r.broadcast_id=b.id AND r.user_id=$1
    ) n WHERE coalesce((SELECT (details->>'notifications')::boolean FROM student.profiles WHERE user_id=$1),true) ORDER BY created_at DESC LIMIT 50`,
          [req.actor.id],
        )
      ).rows,
    })),
  );
  api.post("/student/notifications/read", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      await client.query(
        "UPDATE student.notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",
        [req.actor.id],
      );
      await client.query(
        "INSERT INTO student.notice_reads(user_id,broadcast_id) SELECT $1,id FROM student.broadcasts ON CONFLICT DO NOTHING",
        [req.actor.id],
      );
      return { data: { read: true } };
    }),
  );
}
