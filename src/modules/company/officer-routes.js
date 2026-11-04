// Placement officer side of the company portal: invitations, drive request
// review, audience targeting and releasing applicants. Each SQL function
// re-checks the officer (placement.assert_officer).
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hashToken, sqlCall } from "./routes.js";

const year = z.string().regex(/^20\d{2}$/);
const limit = (max) => z.union([z.number().min(0).max(max), z.literal(""), z.null()]);
export const audienceSchema = z
  .object({
    // "selected": only the students in `add`; the filters are ignored.
    mode: z.enum(["rules", "selected"]).optional(),
    batches: z.array(year).max(10).default([]),
    branches: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    min_cgpa: limit(10).optional(),
    max_backlogs: z.union([z.number().int().min(0).max(100), z.literal(""), z.null()]).optional(),
    min_attendance: limit(100).optional(),
    add: z.array(z.uuid()).max(5000).default([]),
    remove: z.array(z.uuid()).max(5000).default([]),
  })
  .strict();

export function registerCompanyOfficerRoutes(api, { pool }) {
  const call = (req, sql, values) => sqlCall(pool, req.actor.id, sql, values);
  const id = (req) => z.uuid().parse(req.params.id);

  api.get("/placement/company-requests", async (req) => {
    const q = z
      .object({ status: z.enum(["submitted", "returned", "approved", "rejected"]).optional(), search: z.string().max(100).optional() })
      .strict()
      .parse(req.query);
    return { data: await call(req, "SELECT placement.drive_requests($1::jsonb) AS result", [JSON.stringify(q)]) };
  });
  api.get("/placement/company-requests/:id", async (req) => ({
    data: await call(req, "SELECT placement.drive_request($1::uuid) AS result", [id(req)]),
  }));
  api.post("/placement/company-requests/:id/review", { bodyLimit: 400000 }, async (req) => {
    const body = z
      .object({
        decision: z.enum(["approve", "return", "reject"]),
        comment: z.string().max(2000).optional(),
        revision: z.number().int().min(1).optional(),
        academic_year: z.string().regex(/^20\d{2}-(\d{2}|20\d{2})$/).optional(),
        audience: audienceSchema.optional(),
      })
      .strict()
      .parse(req.body);
    const { decision, ...payload } = body;
    return {
      data: await call(req, "SELECT placement.review_request($1::uuid,$2,$3::jsonb) AS result", [id(req), decision, JSON.stringify(payload)]),
    };
  });

  api.post("/placement/audience/preview", { bodyLimit: 400000 }, async (req) => {
    const { spec, search, page } = z
      .object({ spec: audienceSchema, search: z.string().max(100).optional(), page: z.number().int().min(1).max(1000).optional() })
      .strict()
      .parse(req.body);
    return {
      data: await call(req, "SELECT placement.audience_preview($1::jsonb,$2::jsonb) AS result", [
        JSON.stringify(spec),
        JSON.stringify({ search: search || "", page: String(page || 1), limit: "50" }),
      ]),
    };
  });
  api.get("/placement/audience/search", async (req) => {
    const { q } = z.object({ q: z.string().max(100) }).strict().parse(req.query);
    return { data: await call(req, "SELECT placement.audience_search($1,20) AS result", [q]) };
  });
  api.get("/placement/drives/:id/audience", async (req) => ({
    data: await call(req, "SELECT placement.drive_audience_state($1::uuid) AS result", [id(req)]),
  }));
  api.post("/placement/drives/:id/audience", { bodyLimit: 400000 }, async (req) => {
    const spec = audienceSchema.parse(req.body);
    return { data: await call(req, "SELECT placement.save_audience($1::uuid,$2::jsonb) AS result", [id(req), JSON.stringify(spec)]) };
  });
  api.post("/placement/drives/:id/release", { bodyLimit: 1000 }, async (req) => {
    const { release } = z.object({ release: z.boolean() }).strict().parse(req.body);
    return { data: await call(req, "SELECT placement.release_applicants($1::uuid,$2) AS result", [id(req), release]) };
  });

  api.get("/placement/companies/:id/access", async (req) => ({
    data: await call(req, "SELECT placement.company_access($1::uuid) AS result", [id(req)]),
  }));
  // The token is returned once, to build the invitation link; only its hash is stored.
  api.post("/placement/companies/:id/invites", { bodyLimit: 2000, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { email, name } = z
      .object({ email: z.email().max(320), name: z.string().trim().max(200).optional() })
      .strict()
      .parse(req.body);
    const token = randomBytes(32).toString("base64url");
    const invite = await call(req, "SELECT placement.company_invite($1::uuid,$2,$3,$4) AS result", [id(req), email, name || "", hashToken(token)]);
    return { data: { ...invite, token } };
  });
  api.post("/placement/company-invites/:id/revoke", { bodyLimit: 1000 }, async (req) => ({
    data: await call(req, "SELECT placement.company_invite_revoke($1::uuid) AS result", [id(req)]),
  }));
  api.post("/placement/company-members/:id/revoke", { bodyLimit: 1000 }, async (req) => ({
    data: await call(req, "SELECT placement.company_member_revoke($1::uuid) AS result", [id(req)]),
  }));
}
