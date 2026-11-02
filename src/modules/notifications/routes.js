// One notifications API for every role. Students read their personal notices
// and batch broadcasts; officers and company members read erp.notifications.
// Only unread items are listed: marking one as read removes it from the list,
// while the row (with read_at) stays for audit.
import { z } from "zod";
import { withActor } from "../../integrations/supabase/db.js";
import { httpError } from "../../platform/http/errors.js";

const LIMIT = 50;

async function audienceOf(client) {
  const { rows } = await client.query(
    "SELECT erp.actor_role() AS role, student.is_officer() AS officer, company.is_member() AS company",
  );
  const row = rows[0];
  if (row.officer) return "officer";
  if (row.role === "student") return "student";
  if (row.company) return "company";
  throw httpError(403, "FORBIDDEN", "Sign in with a campus or company account.");
}

const STUDENT_UNREAD = `SELECT * FROM (
    SELECT id,'personal' AS source,title,body,href,created_at FROM student.notifications WHERE user_id=$1 AND read_at IS NULL
    UNION ALL
    SELECT b.id,'broadcast',b.title,b.body,b.href,b.created_at FROM student.broadcasts b
      WHERE NOT EXISTS(SELECT 1 FROM student.notice_reads r WHERE r.broadcast_id=b.id AND r.user_id=$1)
  ) n WHERE coalesce((SELECT (details->>'notifications')::boolean FROM student.profiles WHERE user_id=$1),true)`;

export async function unreadNotifications(client, actor, limit = LIMIT) {
  const audience = await audienceOf(client);
  if (audience === "student") {
    const { rows } = await client.query(
      `SELECT x.*,count(*) OVER()::int AS total FROM (${STUDENT_UNREAD}) x ORDER BY created_at DESC,id LIMIT $2`,
      [actor, limit],
    );
    return { audience, rows, unread: rows[0]?.total ?? 0 };
  }
  const { rows } = await client.query(
    `SELECT id,'personal' AS source,kind,title,body,href,created_at,count(*) OVER()::int AS total
     FROM erp.notifications WHERE recipient=$1 AND read_at IS NULL ORDER BY created_at DESC,id LIMIT $2`,
    [actor, limit],
  );
  return { audience, rows, unread: rows[0]?.total ?? 0 };
}

export function registerNotificationRoutes(api, { pool }) {
  api.get("/notifications", async (req) =>
    withActor(pool, req.actor.id, async (client) => {
      const result = await unreadNotifications(client, req.actor.id);
      return { data: { audience: result.audience, unread: result.unread, rows: result.rows.map(({ total, ...row }) => row) } };
    }),
  );
  api.post("/notifications/:id/read", { bodyLimit: 1000 }, async (req) => {
    const id = z.uuid().parse(req.params.id);
    const { source } = z.object({ source: z.enum(["personal", "broadcast"]).default("personal") }).strict().parse(req.body || {});
    return withActor(pool, req.actor.id, async (client) => {
      const audience = await audienceOf(client);
      let count;
      if (audience === "student" && source === "broadcast")
        count = (
          await client.query(
            "INSERT INTO student.notice_reads(user_id,broadcast_id) SELECT $1,id FROM student.broadcasts WHERE id=$2 ON CONFLICT DO NOTHING",
            [req.actor.id, id],
          )
        ).rowCount;
      else if (audience === "student")
        count = (await client.query("UPDATE student.notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL", [id, req.actor.id])).rowCount;
      else
        count = (await client.query("UPDATE erp.notifications SET read_at=now() WHERE id=$1 AND recipient=$2 AND read_at IS NULL", [id, req.actor.id])).rowCount;
      return { data: { read: count > 0 } };
    });
  });
  api.post("/notifications/read-all", { bodyLimit: 1000 }, async (req) =>
    withActor(pool, req.actor.id, async (client) => {
      const audience = await audienceOf(client);
      if (audience === "student") {
        await client.query("UPDATE student.notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.actor.id]);
        await client.query("INSERT INTO student.notice_reads(user_id,broadcast_id) SELECT $1,id FROM student.broadcasts ON CONFLICT DO NOTHING", [req.actor.id]);
      } else await client.query("UPDATE erp.notifications SET read_at=now() WHERE recipient=$1 AND read_at IS NULL", [req.actor.id]);
      return { data: { read: true } };
    }),
  );
}
