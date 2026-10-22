import { registerOfficerTools } from "./modules/students/officer-tools.js";
import { createStudentAI } from "./modules/students/ai.js";
import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { httpError, sameSecret, isPendingMigration } from "./platform/http/errors.js";
import { schemaStatus } from "./platform/database/readiness.js";
import { authVerifier } from "./modules/identity/auth.js";
import { registerIdentityRoutes } from './modules/identity/routes.js';
import {registerRegistrationRoutes} from './modules/students/registration.js';
import { registerCampusRoutes } from "./modules/campus/routes.js";
import { registerPortalRoutes } from "./modules/portal/routes.js";
import { registerStudentRoutes } from "./modules/students/routes.js";
import { registerDriveIntakeRoutes } from "./modules/portal/drive-intake.js";
import { createResearch } from "./modules/research/index.js";
export { httpError, sameSecret, authVerifier };
export async function buildApp({
  pool,
  env = process.env,
  verify = authVerifier(env),
  logger = true,
  redis,
  studentAi,
  research = createResearch({ env }),
}) {
  if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN.length < 32)
    throw new Error("SERVICE_TOKEN must contain at least 32 characters");
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 15 * 1024 * 1024,
    requestTimeout: 45000,
    // A socket can be idle while research, AI or document extraction runs.
    // Their bounded work can exceed 10 s; closing it early loses the response.
    connectionTimeout: 90000,
    trustProxy: env.TRUST_PROXY === "1" ? 1 : false,
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: (env.CORS_ORIGINS || "")
      .split(",")
      .map((v) => v.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    methods: ["GET", "POST"],
    allowedHeaders: ["authorization", "content-type", "x-service-token"],
  });
  await app.register(rateLimit, {
    max: Number(env.RATE_LIMIT_USER_MAX || 240),
    timeWindow: "1 minute",
    hook: "preHandler",
    redis,
    skipOnError: false,
    keyGenerator: (req) =>
      req.actor ? "user:" + req.actor.id : "ip:" + req.ip,
  });
  const ingress = app.createRateLimit({
    max: Number(env.RATE_LIMIT_IP_MAX || 6000),
    timeWindow: "1 minute",
    keyGenerator: (req) => "ingress:" + req.ip,
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/health/")) return;
    const result = await ingress(req);
    if (result.isExceeded) {
      reply.header("Retry-After", String(result.ttlInSeconds));
      throw httpError(
        429,
        "INGRESS_LIMIT",
        "Too many requests. Please try again shortly.",
      );
    }
  });
  app.addContentTypeParser(
    "text/csv",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Request-Id", _req.id);
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => {
    app.log.info(
      {
        requestId: req.id,
        method: req.method,
        route: req.routeOptions.url,
        status: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      "request",
    );
  });
  app.setErrorHandler((error, req, reply) => {
    const pending = isPendingMigration(error);
    const status = pending
      ? 503
      : error instanceof z.ZodError
        ? 400
        : error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
    const safeFailure = [
      "AI_NOT_CONFIGURED",
      "AI_UNAVAILABLE",
      "AI_TIMEOUT",
      "AI_OUTPUT_LIMIT",
      "AI_INVALID_RESPONSE",
      "INVALID_GRADING",
      "BLUEPRINT_MISMATCH",
    ].includes(error.code);
    // Deliberate 4xx errors (httpError/databaseError) keep their user-facing
    // code and message. Schema and framework validation errors stay generic.
    const exposed =
      safeFailure || (error.expose === true && status >= 400 && status < 500);
    const code = pending
      ? "DATABASE_UPDATE_PENDING"
      : exposed
        ? error.code
        : status === 400
          ? "VALIDATION_ERROR"
          : status >= 500
            ? "SERVICE_UNAVAILABLE"
            : error.code || "REQUEST_FAILED";
    const message = pending
      ? "The campus database update is pending. Ask an administrator to apply the latest database migrations."
      : exposed
        ? error.message
        : status === 400
          ? "Check the request fields and try again."
          : status >= 500
            ? "Service temporarily unavailable. Please try again."
            : error.message;
    if (pending)
      app.log.error(
        {
          requestId: req.id,
          code: "DATABASE_UPDATE_PENDING",
          pgCode: error.code,
          detail: error.message,
          route: req.routeOptions?.url,
          action:
            "Run `npm run db:migrate` in DSU-Backend, then restart the backend.",
        },
        "database_update_pending",
      );
    else if (status >= 500)
      app.log.error(
        { requestId: req.id, code: error.code || "INTERNAL_ERROR" },
        "request_failed",
      );
    reply.code(status).send({ error: { code, message, requestId: req.id } });
  });
  app.get("/health/live", { config: { rateLimit: false } }, async () => ({
    status: "ok",
  }));
  app.get(
    "/health/ready",
    { config: { rateLimit: false } },
    async (_req, reply) => {
      try {
        const schema = await schemaStatus(pool);
        if (!schema.ready)
          return reply
            .code(503)
            .send({ status: "unavailable", reason: "database_update_pending" });
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    },
  );

  const generate = createStudentAI(pool, env, studentAi, { logger: app.log });
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
    registerIdentityRoutes(api, { pool });
    registerRegistrationRoutes(api, {pool});
    registerCampusRoutes(api, { pool });
    registerPortalRoutes(api, { pool });
    registerStudentRoutes(api, { pool, generate, env, research });
    registerDriveIntakeRoutes(api, { pool, generate });
    registerOfficerTools(api, { pool, env, generate });
  };
  await app.register(registerRoutes, {
    prefix: "/v1",
    requireServiceToken: true,
  });
  await app.register(registerRoutes, {
    prefix: "/api/v1",
    requireServiceToken: false,
  });
  app.addHook("onClose", async () => {
    await Promise.resolve(research?.close?.()).catch(() => {});
    await pool.end();
  });
  return app;
}
