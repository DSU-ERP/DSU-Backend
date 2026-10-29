// Students Ranking: Placement Officer reads. Officer access, cohort rules and
// dense ranking are enforced in the placement.ranking_* SQL functions; these
// routes validate the query strictly and never calculate scores.
// See docs/student-ranking/architecture.md.
import { z } from "zod";
import { withActor } from "../../integrations/supabase/db.js";
import { databaseError } from "../../platform/http/errors.js";

const opt = (max) => z.string().trim().max(max).optional();
const batch = z.string().regex(/^20[0-9]{2}$/).optional();
const cohort = { batch, department: opt(200), semester: opt(20) };
const overviewQuery = z.object(cohort).strict();
const listQuery = z
  .object({
    ...cohort,
    kind: z.enum(["academic", "dsa", "github", "developer", "topic"]).optional(),
    topic: z.string().regex(/^[a-z]+\.[a-z0-9-]{2,40}$/).optional(),
    evidence: z.enum(["complete", "partial", "pending"]).optional(),
    updated: z.enum(["7", "30", "older"]).optional(),
    show: z.enum(["ranked", "all"]).optional(),
    search: opt(100),
    page: z.string().regex(/^[1-9][0-9]{0,5}$/).optional(),
    limit: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
  })
  .strict()
  .refine((q) => q.kind !== "topic" || q.topic, { message: "Choose a topic." });

const compact = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== ""));

export function registerRankingRoutes(api, { pool }) {
  // PT4xx errors raised by the SQL guards become their HTTP statuses.
  const read = (req, sql, value) =>
    withActor(pool, req.actor.id, async (client) => {
      try {
        return (await client.query(sql, [value])).rows[0].result;
      } catch (error) {
        throw databaseError(error);
      }
    });

  api.get("/placement/rankings/overview", async (req) =>
    read(req, "SELECT placement.ranking_overview($1::jsonb) AS result", JSON.stringify(compact(overviewQuery.parse(req.query)))),
  );

  api.get("/placement/rankings", async (req) =>
    read(req, "SELECT placement.ranking_list($1::jsonb) AS result", JSON.stringify(compact(listQuery.parse(req.query)))),
  );

  api.get("/placement/rankings/students/:id", async (req) =>
    read(req, "SELECT placement.ranking_student($1::uuid) AS result", z.uuid().parse(req.params.id)),
  );
}
