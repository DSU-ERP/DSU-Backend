import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

export async function buildApp({
  env = process.env,
  request = fetch,
  logger = true,
} = {}) {
  const upstream = new URL(env.DSU_API_URL);
  if (env.NODE_ENV === "production" && upstream.protocol !== "https:")
    throw new Error("Production DSU_API_URL requires HTTPS");
  if (
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname !== "/"
  )
    throw new Error("DSU_API_URL must be an origin");
  if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN.length < 32)
    throw new Error("Missing secure SERVICE_TOKEN");
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
    allowedHeaders: ["authorization", "content-type"],
  });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.addContentTypeParser(
    "text/csv",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (req, reply) =>
    app.log.info(
      {
        requestId: req.id,
        method: req.method,
        route: req.routeOptions.url,
        status: reply.statusCode,
      },
      "request",
    ),
  );
  app.setErrorHandler((error, req, reply) =>
    reply
      .code(error.statusCode || 500)
      .send({
        error: {
          code: "REQUEST_FAILED",
          message: "Unable to process request.",
          requestId: req.id,
        },
      }),
  );
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      const res = await request(new URL("/health/ready", upstream), {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { status: "ready" };
    } catch {}
    return reply.code(503).send({ status: "unavailable" });
  });
  for (const [method, path] of [
    ["GET", "/me"],
    ["GET", "/overview"],
    ["GET", "/students"],
    ["GET", "/students/:id"],
    ["GET", "/imports"],
    ["POST", "/imports"],
  ]) {
    app.route({
      method,
      url: `/api/v1${path}`,
      handler: async (req, reply) => {
        if (!/^Bearer \S{1,8192}$/.test(req.headers.authorization || ""))
          return reply
            .code(401)
            .send({
              error: {
                code: "UNAUTHENTICATED",
                message: "Sign in to continue.",
                requestId: req.id,
              },
            });
        if (req.params.id && !/^[0-9a-f-]{36}$/i.test(req.params.id))
          return reply
            .code(400)
            .send({
              error: {
                code: "INVALID_ID",
                message: "Invalid record identifier.",
              },
            });
        const url = new URL(
          `/v1${path.replace(":id", req.params.id || "")}`,
          upstream,
        );
        for (const [k, v] of Object.entries(req.query)) {
          if (typeof v !== "string")
            return reply
              .code(400)
              .send({
                error: { code: "INVALID_QUERY", message: "Invalid query." },
              });
          url.searchParams.set(k, v);
        }
        try {
          const response = await request(url, {
            method,
            headers: {
              Authorization: req.headers.authorization,
              "x-service-token": env.SERVICE_TOKEN,
              ...(method === "POST" ? { "Content-Type": "text/csv" } : {}),
            },
            body: method === "POST" ? req.body : undefined,
            signal: AbortSignal.timeout(method === "POST" ? 40000 : 12000),
            redirect: "error",
          });
          const payload = await response.json();
          if (response.status >= 500)
            return reply
              .code(503)
              .send({
                error: {
                  code: "UPSTREAM_UNAVAILABLE",
                  message: "Campus services are temporarily unavailable.",
                  requestId: req.id,
                },
              });
          return reply.code(response.status).send(payload);
        } catch {
          return reply
            .code(503)
            .send({
              error: {
                code: "UPSTREAM_UNAVAILABLE",
                message:
                  "Campus services are temporarily unavailable. Please try again.",
                requestId: req.id,
              },
            });
        }
      },
    });
  }
  return app;
}
