import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { withActor } from "./integrations/supabase/db.js";
import { importStudents } from "./modules/imports/importer.js";
import { registerAnalytics } from "./modules/analytics/studentAnalytics.js";
import {
  categorySql,
  categoryDefinition,
} from "./modules/analytics/categoryRules.js";

export function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function authVerifier(env) {
  return async (token) => {
    let response;
    try {
      response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw httpError(
        503,
        "AUTH_UNAVAILABLE",
        "Authentication is temporarily unavailable.",
      );
    }
    if (response.status >= 500 || response.status === 429)
      throw httpError(
        503,
        "AUTH_UNAVAILABLE",
        "Authentication is temporarily unavailable.",
      );
    if (!response.ok)
      throw httpError(401, "UNAUTHENTICATED", "Please sign in again.");
    const user = await response.json();
    if (!z.uuid().safeParse(user.id).success)
      throw httpError(401, "UNAUTHENTICATED", "Please sign in again.");
    return { id: user.id };
  };
}

export async function buildApp({
  pool,
  env = process.env,
  verify = authVerifier(env),
  logger = true,
}) {
  if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN.length < 32)
    throw new Error("SERVICE_TOKEN must contain at least 32 characters");
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 45000,
    connectionTimeout: 10000,
    trustProxy: env.TRUST_PROXY === "1" ? 1 : false,
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: (env.CORS_ORIGINS || "").split(",").filter(Boolean),
    methods: ["GET", "POST"],
    allowedHeaders: ["authorization", "content-type", "x-service-token"],
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addContentTypeParser(
    "text/csv",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => {
    app.log.info(
      {
        requestId: req.id,
        method: req.method,
        route: req.routeOptions.url,
        status: reply.statusCode,
      },
      "request",
    );
  });
  app.setErrorHandler((error, req, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
    const message =
      status === 400
        ? "Check the request fields and try again."
        : status >= 500
          ? "Service temporarily unavailable. Please try again."
          : error.message;
    if (status >= 500)
      app.log.error(
        { requestId: req.id, code: error.code || "INTERNAL_ERROR" },
        "request_failed",
      );
    reply.code(status).send({
      error: {
        code:
          status === 400
            ? "VALIDATION_ERROR"
            : status >= 500
              ? "SERVICE_UNAVAILABLE"
              : error.code || "REQUEST_FAILED",
        message,
        requestId: req.id,
      },
    });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1 FROM erp.students LIMIT 0");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  // Register the same authenticated handlers in either deployment topology.
  // /v1 stays service-protected; optional /api/v1 is the public gateway surface.
  const registerRoutes = async (api, { requireServiceToken }) => {
    api.addHook("preHandler", async (req) => {
      if (
        requireServiceToken &&
        !sameSecret(req.headers["x-service-token"], env.SERVICE_TOKEN)
      )
        throw httpError(
          401,
          "UNAUTHENTICATED",
          "Backend authentication required.",
        );
      const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!token || token.length > 8192)
        throw httpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      req.actor = await verify(token);
    });
    const run = (req, allowed, fn, options) =>
      withActor(
        pool,
        req.actor.id,
        async (client) => {
          const { rows } = await client.query(
            "SELECT role, student_id FROM erp.memberships WHERE user_id=$1",
            [req.actor.id],
          );
          const membership = rows[0];
          if (!membership || (allowed && !allowed.includes(membership.role)))
            throw httpError(
              403,
              "FORBIDDEN",
              "Your account does not have access to this resource.",
            );
          return fn(client, membership);
        },
        options,
      );
    const audit = (client, req, action, resource = null) =>
      client.query(
        "INSERT INTO erp.audit_events(actor_id,action,resource_id) VALUES ($1,$2,$3)",
        [req.actor.id, action, resource],
      );
    registerAnalytics(api, { run, audit, httpError });
    api.get("/me", async (req) =>
      run(req, null, async (_client, m) => ({
        data: { id: req.actor.id, role: m.role, studentId: m.student_id },
      })),
    );
    api.get("/overview", async (req) =>
      run(req, ["admin", "staff"], async (client) => {
        const totals = await client.query(
          "SELECT count(*)::int AS students,count(DISTINCT department_short_name)::int AS departments,count(DISTINCT source_batch)::int AS batches FROM erp.students",
        );
        const departments = await client.query(
          "SELECT department_short_name AS name,count(*)::int AS students FROM erp.students GROUP BY 1 ORDER BY 2 DESC",
        );
        await audit(client, req, "overview.read");
        return {
          data: { ...totals.rows[0], departmentBreakdown: departments.rows },
        };
      }),
    );
    api.get("/students", async (req) => {
      const q = z
        .object({
          page: z.coerce.number().int().min(1).max(100000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          search: z.string().trim().max(100).default(""),
          batch: z
            .string()
            .regex(/^20\d{2}$/)
            .optional(),
        })
        .strict()
        .parse(req.query);
      return run(req, ["admin", "staff"], async (client) => {
        // Prefix search, escaped LIKE characters; never interpolate user input.
        const search = q.search.replace(/[\\%_]/g, "\\$&") + "%";
        const params = [search, q.batch || null];
        const where =
          "(s.full_name ILIKE $1 OR s.enrollment_no ILIKE $1) AND ($2::text IS NULL OR s.source_batch=$2)";
        const total = await client.query(
          `SELECT count(*)::int AS count FROM erp.students s WHERE ${where}`,
          params,
        );
        const classification = categorySql("a.cgpa", (value) => {
          params.push(value);
          return `$${params.length}`;
        });
        const rows = await client.query(
          `SELECT s.id,s.enrollment_no,s.full_name,s.department_short_name,s.source_batch,s.current_semester,s.status,a.cgpa,a.attendance,${classification} AS category_id FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id WHERE ${where} ORDER BY s.enrollment_no LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, q.limit, (q.page - 1) * q.limit],
        );
        await audit(client, req, "students.list");
        return {
          data: rows.rows.map((student) => ({
            ...student,
            category: categoryDefinition(student.category_id),
          })),
          pagination: {
            page: q.page,
            limit: q.limit,
            total: total.rows[0].count,
          },
        };
      });
    });
    api.get("/students/:id", async (req) => {
      const id = z.uuid().parse(req.params.id);
      return run(req, null, async (client, m) => {
        const result = await client.query(
          "SELECT id,enrollment_no,full_name,display_no,course_name,department_name,current_semester,current_batch,current_division,status,source_batch FROM erp.students WHERE id=$1",
          [id],
        );
        if (!result.rows[0])
          throw httpError(404, "NOT_FOUND", "Student record not found.");
        const academic = await client.query(
          "SELECT attendance,achievements,cgpa,percentage,sgpa,current_backlog,total_backlog FROM erp.academics WHERE student_id=$1",
          [id],
        );
        let contact = null,
          fees = null;
        if (m.role !== "staff") {
          contact =
            (
              await client.query(
                "SELECT details FROM erp.contacts WHERE student_id=$1",
                [id],
              )
            ).rows[0]?.details || null;
          fees =
            (
              await client.query(
                "SELECT fees_paid,fees_outstanding,fee_category FROM erp.academics WHERE student_id=$1",
                [id],
              )
            ).rows[0] || null;
        }
        await audit(client, req, "student.read", id);
        return {
          data: {
            ...result.rows[0],
            academic: academic.rows[0] || null,
            contact,
            fees,
          },
        };
      });
    });
    api.get("/imports", async (req) =>
      run(req, ["admin"], async (client) => ({
        data: (
          await client.query(
            "SELECT id,source_batch,summary,created_at FROM erp.import_runs ORDER BY created_at DESC LIMIT 20",
          )
        ).rows,
      })),
    );
    api.post(
      "/imports",
      { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
      async (req) => {
        const { batch } = z
          .object({ batch: z.string().regex(/^20\d{2}$/) })
          .strict()
          .parse(req.query);
        if (
          typeof req.body !== "string" ||
          !req.headers["content-type"]?.startsWith("text/csv")
        )
          throw httpError(415, "INVALID_CONTENT_TYPE", "Upload a CSV file.");
        return run(req, ["admin"], async (client) => {
          try {
            return {
              data: await importStudents(
                client,
                Readable.from([req.body]),
                batch,
                req.actor.id,
              ),
            };
          } catch (e) {
            if (e.code) throw e;
            throw httpError(
              400,
              "INVALID_CSV",
              "CSV structure is invalid; no changes were saved.",
            );
          }
        });
      },
    );
  };
  await app.register(registerRoutes, {
    prefix: "/v1",
    requireServiceToken: true,
  });
  // Consolidated deployment: /api/v1 is the public contract the web
  // application calls through DSU_BACKEND_URL. It is always registered now
  // that the separate gateway process is retired. Authorisation is unchanged:
  // a Supabase-verified user bearer token plus an erp.memberships role check
  // on every request. The service token only ever guarded the internal hop
  // between the two processes, so it is not a boundary on this path.
  //
  // /v1 above is retained unchanged so the previous gateway contract keeps
  // working during cutover and nothing has to be switched atomically.
  await app.register(registerRoutes, {
    prefix: "/api/v1",
    requireServiceToken: false,
  });
  app.addHook("onClose", async () => pool.end());
  return app;
}
