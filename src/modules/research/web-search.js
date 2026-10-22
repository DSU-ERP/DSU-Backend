// Web research through official search APIs only: the Brave Search API and the
// Google Programmable Search (Custom Search JSON) API. Search result pages are
// never scraped. Results are untrusted third-party text: every title and
// snippet is reduced to plain text and only http(s) URLs are kept.
export const MAX_RESULTS = 5;
export const SEARCH_TIMEOUT_MS = 6000;
export const CACHE_TTL_MS = 15 * 60 * 1000;
// Brave rejects queries over 400 characters or 50 words.
export const QUERY_LIMIT = 380;
export const QUERY_WORD_LIMIT = 50;
const CACHE_LIMIT = 200;
const RESPONSE_LIMIT = 2 * 1024 * 1024;

const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntity(match, body) {
  if (body[0] === "#") {
    const code =
      body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
    const valid =
      Number.isInteger(code) &&
      code > 31 &&
      code <= 0x10ffff &&
      !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : " ";
  }
  return named[body.toLowerCase()] ?? match;
}

/** Plain, single-line text: tags removed, entities decoded, length capped. */
export function plainText(value, max = 400) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, decodeEntity)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f​⁠﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Absolute http(s) URL without embedded credentials, or null. */
export function safeUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function normalizeQuery(query) {
  return String(query ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, QUERY_WORD_LIMIT)
    .join(" ")
    .slice(0, QUERY_LIMIT)
    .trim();
}

/** Requested result count clamped to 1..MAX_RESULTS (default MAX_RESULTS). */
export const resultLimit = (count) =>
  Math.max(1, Math.min(MAX_RESULTS, Math.trunc(Number(count)) || MAX_RESULTS));

/** Sanitised, de-duplicated results (at most MAX_RESULTS). */
export function cleanResults(items) {
  const seen = new Set(),
    results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const url = safeUrl(item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: plainText(item.title, 200) || domainOf(url),
      url,
      description: plainText(item.description, 400),
    });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

const PROVIDERS = {
  brave: {
    configured: (env) => !!env.BRAVE_SEARCH_API_KEY,
    request(env, query) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.search = new URLSearchParams({
        q: query,
        count: String(MAX_RESULTS),
        country: "IN",
        search_lang: "en",
        ui_lang: "en-IN",
        safesearch: "moderate",
        text_decorations: "false",
      }).toString();
      return {
        url,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
        },
      };
    },
    results: (data) =>
      (Array.isArray(data?.web?.results) ? data.web.results : []).map(
        (item) => ({
          title: item?.title,
          url: item?.url,
          description: item?.description,
        }),
      ),
  },
  google: {
    configured: (env) => !!(env.GOOGLE_SEARCH_API_KEY && env.GOOGLE_SEARCH_CX),
    request(env, query) {
      const url = new URL("https://www.googleapis.com/customsearch/v1");
      url.search = new URLSearchParams({
        key: env.GOOGLE_SEARCH_API_KEY,
        cx: env.GOOGLE_SEARCH_CX,
        q: query,
        num: String(MAX_RESULTS),
        gl: "in",
        hl: "en",
        safe: "active",
      }).toString();
      return { url, headers: { Accept: "application/json" } };
    },
    results: (data) =>
      (Array.isArray(data?.items) ? data.items : []).map((item) => ({
        title: item?.title,
        url: item?.link,
        description: item?.snippet,
      })),
  },
};
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

/** Configured providers in WEB_SEARCH_PROVIDERS order (default brave,google). */
export function providerOrder(env = {}) {
  const requested = String(env.WEB_SEARCH_PROVIDERS || "brave,google")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(requested)].filter((name) =>
    PROVIDERS[name]?.configured(env),
  );
}

class SearchFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * search(query, count) resolves to
 *   { status: "ok" | "no-results" | "failed" | "unavailable", provider, cached, results }
 * and never rejects. Errors never include request URLs, because the Google
 * API key travels in the query string.
 */
export function createWebSearch({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = SEARCH_TIMEOUT_MS,
} = {}) {
  const providers = providerOrder(env);
  const cache = new Map();
  async function call(name, query) {
    const provider = PROVIDERS[name];
    const { url, headers } = provider.request(env, query);
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SearchFailure("timeout"));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetchImpl(url, {
          headers,
          signal: controller.signal,
          redirect: "error",
        }),
        expired,
      ]);
      if (!response?.ok)
        throw new SearchFailure("http_" + (response?.status || "error"));
      const body = await Promise.race([response.text(), expired]);
      if (typeof body !== "string" || body.length > RESPONSE_LIMIT)
        throw new SearchFailure("invalid_response");
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new SearchFailure("invalid_response");
      }
      return cleanResults(provider.results(data));
    } catch (error) {
      throw error instanceof SearchFailure
        ? error
        : new SearchFailure(controller.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }
  async function search(query, count = MAX_RESULTS) {
    const limit = resultLimit(count);
    const q = normalizeQuery(query);
    if (!providers.length)
      return { status: "unavailable", provider: null, cached: false, results: [] };
    if (!q)
      return { status: "no-results", provider: null, cached: false, results: [] };
    const key = q.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > now())
      return {
        status: "ok",
        provider: hit.provider,
        cached: true,
        results: hit.results.slice(0, limit),
      };
    if (hit) cache.delete(key);
    const failures = [];
    for (const name of providers) {
      try {
        const results = await call(name, q);
        if (!results.length) {
          failures.push("empty");
          continue;
        }
        cache.set(key, { provider: name, results, expires: now() + CACHE_TTL_MS });
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        return { status: "ok", provider: name, cached: false, results: results.slice(0, limit) };
      } catch (error) {
        failures.push(error.code || "error");
      }
    }
    return {
      status: failures.every((code) => code === "empty") ? "no-results" : "failed",
      provider: null,
      cached: false,
      results: [],
    };
  }
  return { enabled: providers.length > 0, providers, search };
}
