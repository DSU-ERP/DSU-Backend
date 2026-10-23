// Pure validation and normalisation of platform identities and
// student-submitted figures. Nothing here fetches a URL: a profile URL is only
// parsed, checked against a fixed host allowlist and then rebuilt from the
// validated handle, so the stored URL is always one we constructed.
import { z } from "zod";
import { PLATFORMS } from "./constants.js";

const ASCII_PRINTABLE = /^[\x21-\x7e]+$/;

const RULES = {
  github: {
    // 1-39 characters, alphanumeric or single hyphens, no leading/trailing hyphen.
    handle: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
    hosts: ["github.com", "www.github.com"],
    paths: [[]],
    reserved: ["about", "apps", "codespaces", "collections", "dashboard", "enterprise", "events", "explore",
      "features", "issues", "join", "login", "logout", "marketplace", "new", "notifications", "organizations",
      "orgs", "pricing", "pulls", "search", "security", "settings", "site", "sponsors", "topics", "trending", "users"],
    url: (h) => `https://github.com/${h}`,
  },
  leetcode: {
    handle: /^[A-Za-z0-9_-]{1,30}$/,
    hosts: ["leetcode.com", "www.leetcode.com"],
    paths: [["u"], []],
    reserved: ["accounts", "assessment", "contest", "discuss", "explore", "interview", "problems", "problemset",
      "store", "studyplan", "subscribe", "u", "profile", "settings"],
    url: (h) => `https://leetcode.com/u/${h}/`,
  },
  hackerrank: {
    handle: /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,38}[A-Za-z0-9_])?$/,
    hosts: ["hackerrank.com", "www.hackerrank.com"],
    paths: [["profile"], []],
    reserved: ["about", "auth", "blog", "careers", "certificates", "certify", "challenges", "contests", "dashboard",
      "domains", "interview", "jobs", "leaderboard", "login", "prepare", "products", "profile", "settings",
      "skills-verification", "work"],
    url: (h) => `https://www.hackerrank.com/profile/${h}`,
  },
  linkedin: {
    // Custom public profile URLs: 3-100 letters, digits or hyphens.
    handle: /^[A-Za-z0-9_-]{3,100}$/,
    hosts: ["linkedin.com", "www.linkedin.com"],
    countryHosts: /^[a-z]{2}\.linkedin\.com$/,
    paths: [["in"]],
    reserved: [],
    url: (h) => `https://www.linkedin.com/in/${h}`,
  },
  huggingface: {
    handle: /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?=[A-Za-z0-9_-])){0,41}$/,
    hosts: ["huggingface.co"],
    paths: [[]],
    reserved: ["api", "blog", "chat", "collections", "datasets", "docs", "enterprise", "join", "learn", "login",
      "models", "new", "organizations", "papers", "posts", "pricing", "settings", "spaces", "tasks"],
    url: (h) => `https://huggingface.co/${h}`,
  },
  kaggle: {
    handle: /^[A-Za-z0-9_-]{1,40}$/,
    hosts: ["kaggle.com", "www.kaggle.com"],
    paths: [[]],
    reserved: ["about", "account", "code", "competitions", "contact", "datasets", "discussion", "discussions",
      "docs", "learn", "models", "organizations", "search", "settings", "work"],
    url: (h) => `https://www.kaggle.com/${h}`,
  },
};

export const INVALID_HANDLE = "INVALID_PLATFORM_HANDLE";
const invalid = () => null;

/**
 * Accepts a bare username or an https URL on the platform's allowlisted hosts.
 * Returns {handle, profileUrl} with a URL we built ourselves, or null.
 */
export function normalizePlatformValue(platform, input) {
  const rule = RULES[platform];
  if (!rule || typeof input !== "string") return invalid();
  const value = input.trim();
  if (!value || value.length > 300 || !ASCII_PRINTABLE.test(value)) return invalid();
  const accept = (handle) =>
    rule.handle.test(handle) && !rule.reserved.includes(handle.toLowerCase())
      ? { handle, profileUrl: rule.url(handle) }
      : invalid();
  if (!value.includes("/") && !value.includes(":")) return accept(value);
  // URL form: exact scheme, no credentials, port, query, fragment, backslashes or encoding tricks.
  if (!value.startsWith("https://") || /[\\@%?#\s]/.test(value)) return invalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return invalid();
  const authority = value.slice("https://".length).split("/")[0].toLowerCase();
  const host = url.hostname;
  // The raw authority must be exactly the hostname (no port, userinfo or trailing dot).
  if (authority !== host) return invalid();
  if (!rule.hosts.includes(host) && !(rule.countryHosts && rule.countryHosts.test(host))) return invalid();
  const segments = url.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop(); // one trailing slash
  if (segments.some((s) => s === "")) return invalid();
  for (const prefix of rule.paths) {
    if (segments.length !== prefix.length + 1) continue;
    if (prefix.every((p, i) => segments[i].toLowerCase() === p)) {
      const handle = segments[prefix.length];
      // A prefixed form like /u/<name> must not be read as the name "u".
      return accept(handle);
    }
  }
  return invalid();
}

// ---- Student-submitted figures ---------------------------------------------
const text = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\u0000-\u001f\u007f-\u009f<>]/.test(v), "Plain text only");
const count = (max) => z.number().int().min(0).max(max);

export const SUBMITTED_SCHEMAS = {
  github: z.object({}).strict(),
  linkedin: z.object({}).strict(),
  huggingface: z.object({}).strict(),
  leetcode: z
    .object({
      solved: count(5000).optional(),
      easy: count(2000).optional(),
      medium: count(3000).optional(),
      hard: count(1500).optional(),
      contestRating: z.number().min(0).max(5000).optional(),
      contestsAttended: count(1000).optional(),
    })
    .strict()
    .refine(
      (v) =>
        [v.solved, v.easy, v.medium, v.hard].some((n) => n === undefined) ||
        v.easy + v.medium + v.hard <= v.solved,
      { message: "Easy, medium and hard cannot add up to more than solved", path: ["solved"] },
    ),
  hackerrank: z
    .object({
      badges: z.array(z.object({ name: text(60), stars: z.number().int().min(0).max(6) }).strict()).max(20).optional(),
      certifications: z
        .array(
          z
            .object({
              name: text(100),
              url: z.string().regex(/^https:\/\/www\.hackerrank\.com\/certificates\/[A-Za-z0-9]{6,64}$/),
            })
            .strict(),
        )
        .max(20)
        .optional(),
    })
    .strict(),
  kaggle: z
    .object({ achievements: z.array(z.object({ title: text(80) }).strict()).max(10).optional() })
    .strict(),
};

/** Validates submitted figures; returns {ok, data} or {ok:false, issues}. */
export function validateSubmitted(platform, submitted = {}) {
  const schema = SUBMITTED_SCHEMAS[platform];
  if (!schema) return { ok: false, issues: ["platform"] };
  const result = schema.safeParse(submitted ?? {});
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, issues: result.error.issues.map((i) => i.path.join(".") || "submitted") };
}

export const SYNCABLE_PLATFORMS = Object.freeze(["github", "huggingface"]);
export const SYNCABLE_AUTH = Object.freeze(["github_app", "github_pat", "public_api"]);
export function isPlatform(value) {
  return PLATFORMS.includes(value);
}

/**
 * Provider failure with a stable code (never a token, URL or payload).
 * Codes: CREDENTIAL_INVALID, RATE_LIMITED (retryAt), PLATFORM_ACCOUNT_NOT_FOUND,
 * PROVIDER_FORBIDDEN, PROVIDER_UNAVAILABLE, OAUTH_EXCHANGE_FAILED,
 * FINE_GRAINED_TOKEN_REQUIRED.
 */
export class ProviderError extends Error {
  constructor(code, message, { status, retryAt } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.providerStatus = status ?? null;
    this.retryAt = retryAt ?? null;
  }
}
