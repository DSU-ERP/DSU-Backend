// Canonical profile reads (student and officer), officer directory, overview
// charts, lookups and AI summaries. Officer access is enforced inside the SQL
// functions (placement.assert_officer); student routes use runStudent.
import { z } from "zod";
import { withActor } from "../../integrations/supabase/db.js";
import { runStudent } from "../students/context.js";
import { getAuthorizedStudentProfile, getMyStudentProfile, officerRead } from "./profile-service.js";
import { generateSummary, updateSummary } from "./summary.js";

const opt = (max) => z.string().trim().max(max).optional();
const batch = z.string().regex(/^20[0-9]{2}$/).optional();
const page = z.string().regex(/^[1-9][0-9]{0,5}$/).optional();
const limit = z.string().regex(/^[1-9][0-9]{0,2}$/).optional();
const cohortQuery = z.object({ batch, department: opt(200) }).strict();
const directoryQuery = z
  .object({
    batch,
    department: opt(200),
    search: opt(100),
    eligibility: z.enum(["eligible", "ineligible"]).optional(),
    skill: z.enum(["complete", "incomplete", "not_started"]).optional(),
    sort: z.enum(["rank", "name", "usn", "cgpa"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    page,
    limit,
    export: z.enum(["true", "false"]).optional(),
  })
  .strict();
const category = z.enum(["advanced", "medium", "needs-improvement"]);
const lookupQuery = z
  .object({ usn: opt(50), name: opt(100) })
  .strict()
  .refine((q) => q.usn || q.name, { message: "Provide a USN or a name." });
const skillQuery = z
  .object({ batch, department: opt(200), status: z.enum(["complete", "incomplete", "not_started"]).optional(), page, limit })
  .strict();
const profileQuery = z.object({ purpose: z.enum(["officer", "ai"]).default("officer") }).strict();
const summaryBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate") }).strict(),
  z.object({ action: z.literal("review"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("hide"), id: z.uuid(), hidden: z.boolean().default(true) }).strict(),
]);

// Drop empty values so the SQL filter treats them as absent.
const compact = (q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== ""));

export function registerProfileRoutes(api, { pool, env = {}, generate } = {}) {
  const officer = (req, fn) => withActor(pool, req.actor.id, fn);

  api.get("/student/skills/profile", async (req) => ({
    data: await runStudent(pool, req.actor.id, (client, ctx) => getMyStudentProfile(client, ctx)),
  }));

  api.post(
    "/student/skills/summary",
    { bodyLimit: 2000, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const body = summaryBody.parse(req.body ?? {});
      if (body.action === "generate")
        return { data: await generateSummary({ pool, generate, env }, req.actor.id) };
      return { data: await updateSummary(pool, req.actor.id, body) };
    },
  );

  // Officer reads. Static segments win over portal's GET /placement/:resource.
  api.get("/placement/categories", async (req) => {
    const q = compact(cohortQuery.parse(req.query));
    return officer(req, (client) => officerRead(client, "category_cards", q));
  });

  api.get("/placement/categories/:category/students", async (req) => {
    const cat = category.parse(req.params.category);
    const q = compact(directoryQuery.parse(req.query));
    return officer(req, (client) => officerRead(client, "ranked_students", { ...q, category: cat }));
  });

  api.get("/placement/overview/charts", async (req) => {
    const q = compact(cohortQuery.extend({ search: opt(100) }).parse(req.query));
    return officer(req, (client) => officerRead(client, "overview_charts", q));
  });

  api.get("/placement/students/lookup", async (req) => {
    const q = compact(lookupQuery.parse(req.query));
    return officer(req, (client) => officerRead(client, "lookup_students", q));
  });

  api.get("/placement/students/:id/profile", async (req) => {
    const id = z.uuid().parse(req.params.id);
    const { purpose } = profileQuery.parse(req.query);
    return { data: await officer(req, (client) => getAuthorizedStudentProfile(client, id, purpose)) };
  });

  api.get("/placement/skills/students", async (req) => {
    const q = compact(skillQuery.parse(req.query));
    return officer(req, (client) => officerRead(client, "skill_students", q));
  });
}
