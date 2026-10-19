import { z } from "zod";
const origin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().url(),
    DATABASE_SSL: z.enum(["true", "false"]).default("true"),
    DATABASE_CA_PATH: z.string().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30000)
      .default(5000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60000)
      .default(15000),
    SUPABASE_URL: origin,
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    SERVICE_TOKEN: z.string().min(32),
    TRUST_PROXY: z.enum(["0", "1"]).default("0"),
    CORS_ORIGINS: z.string().default(""),
    RATE_LIMIT_MODE: z.enum(["memory", "redis"]).default("memory"),
    REDIS_URL: z.string().optional(),
    RATE_LIMIT_USER_MAX: z.coerce.number().int().min(1).max(10000).default(240),
    RATE_LIMIT_IP_MAX: z.coerce
      .number()
      .int()
      .min(100)
      .max(100000)
      .default(6000),
    ASSESSMENT_CODE_SECRET: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().min(32).optional(),
    ),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().optional(),
    OPENROUTER_PROVIDER: z.string().optional(),
    STUDENT_AI_MODEL: z.string().optional(),
    STUDENT_AI_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
    LOG_LEVEL: z
      .enum(["debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
  })
  .superRefine((env, ctx) => {
    const invalid = (path, message) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (
      env.CORS_ORIGINS.split(",")
        .filter(Boolean)
        .some((value) => !origin.safeParse(value.trim()).success)
    )
      invalid("CORS_ORIGINS", "Use exact comma-separated origins");
    if (
      env.RATE_LIMIT_MODE === "redis" &&
      !/^rediss?:\/\//.test(env.REDIS_URL || "")
    )
      invalid("REDIS_URL", "Required for shared rate limiting");
    if (env.NODE_ENV === "production") {
      if (!env.ASSESSMENT_CODE_SECRET)
        invalid(
          "ASSESSMENT_CODE_SECRET",
          "A separate stable class-code secret is required",
        );
      if (!env.SUPABASE_URL.startsWith("https:"))
        invalid("SUPABASE_URL", "HTTPS required");
      if (env.DATABASE_SSL !== "true") invalid("DATABASE_SSL", "TLS required");
      if (env.RATE_LIMIT_MODE !== "redis")
        invalid("RATE_LIMIT_MODE", "Use shared Redis in production");
    }
  });
export function readEnv(values = process.env) {
  if (values.DATABASE_ADMIN_URL)
    throw new Error(
      "Invalid environment: DATABASE_ADMIN_URL must stay in the operator environment",
    );
  const result = schema.safeParse(values);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`,
    );
  // A trailing slash is valid input but must not reach URL concatenation or
  // exact Origin matching (".../" never equals the browser's Origin header).
  return Object.freeze({
    ...result.data,
    SUPABASE_URL: new URL(result.data.SUPABASE_URL).origin,
    CORS_ORIGINS: result.data.CORS_ORIGINS.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin)
      .join(","),
  });
}
