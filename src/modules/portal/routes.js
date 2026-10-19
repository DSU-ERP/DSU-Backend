import { z } from "zod";
import { withActor } from "../../integrations/supabase/db.js";
import { databaseError, httpError } from "../../platform/http/errors.js";
const filters = z.record(z.string().max(40), z.string().max(500));
export function registerPortalRoutes(api, { pool }) {
  api.post("/placement/friday/rename", { bodyLimit: 2000 }, async (req) => {
    const { id, title } = z
      .object({
        id: z.uuid(),
        title: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
      })
      .strict()
      .parse(req.body);
    return withActor(pool, req.actor.id, async (client) => {
      try {
        const { rows } = await client.query(
          "SELECT public.dsu_friday_rename($1::uuid,$2::text) AS result",
          [id, title],
        );
        return rows[0].result;
      } catch (error) {
        throw databaseError(error);
      }
    });
  });
  api.get("/portal/read", async (req) => {
    const { path } = z
      .object({ path: z.string().min(1).max(4096) })
      .strict()
      .parse(req.query);
    const url = new URL(path, "https://portal.invalid");
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      url.origin !== "https://portal.invalid" ||
      url.hash
    )
      throw httpError(400, "INVALID_PATH", "Invalid portal resource.");
    const fn =
      url.pathname === "/batches" || url.pathname.startsWith("/batches/")
        ? "dsu_batch_read"
        : "dsu_portal_read";
    return withActor(pool, req.actor.id, async (client) => {
      try {
        const { rows } = await client.query(
          `SELECT public.${fn}($1,$2::jsonb) AS result`,
          [url.pathname, JSON.stringify(Object.fromEntries(url.searchParams))],
        );
        return rows[0].result;
      } catch (error) {
        throw databaseError(error);
      }
    });
  });
  api.get("/placement/:resource", async (req) => {
    const resource = z
      .string()
      .regex(/^[a-z-]{1,40}$/)
      .parse(req.params.resource);
    const query = filters.parse(req.query);
    return withActor(pool, req.actor.id, async (client) => {
      try {
        const { rows } = await client.query(
          "SELECT public.dsu_placement_read($1,$2::jsonb) AS result",
          [resource, JSON.stringify(query)],
        );
        return rows[0].result;
      } catch (error) {
        throw databaseError(error);
      }
    });
  });
  api.post("/placement/actions/:action", { bodyLimit: 270000 }, async (req) => {
    const action = z
      .string()
      .regex(/^[a-z.]{1,60}$/)
      .parse(req.params.action);
    const { payload, requestId } = z
      .object({ payload: z.record(z.string(), z.json()), requestId: z.uuid() })
      .strict()
      .parse(req.body);
    return withActor(pool, req.actor.id, async (client) => {
      try {
        const { rows } = await client.query(
          "SELECT public.dsu_placement_mutate($1,$2::jsonb,$3::uuid) AS result",
          [action, JSON.stringify(payload), requestId],
        );
        return rows[0].result;
      } catch (error) {
        throw databaseError(error);
      }
    });
  });
}
