// Hugging Face Hub public API (no token). Fixed host, encoded username, 10 s
// timeout, no redirects, 1 MiB response cap, defensive parsing.
import { ProviderError } from "./platforms.js";

const HOST = "https://huggingface.co";
const TIMEOUT_MS = 10000;
const BODY_LIMIT = 1024 * 1024;
const TOP = 5;

/** Seconds until reset from `RateLimit: "api";r=499;t=35` (or Retry-After). */
export function rateLimitDelay(headers) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  const match = String(get("ratelimit") || "").match(/(?:^|;)\s*t=(\d+)/);
  if (match) return Number(match[1]);
  const retry = Number(get("retry-after"));
  return Number.isFinite(retry) && retry >= 0 ? retry : null;
}

async function readCapped(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new ProviderError("PROVIDER_UNAVAILABLE", "Response too large.");
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel().catch(() => {});
      throw new ProviderError("PROVIDER_UNAVAILABLE", "Response too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const date = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;

export function normalizeItems(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item.id === "string" && REPO_ID.test(item.id))
    .map((item) => ({
      id: item.id,
      likes: count(item.likes) ?? 0,
      downloads: count(item.downloads),
      pipelineTag: text(item.pipeline_tag, 100),
      lastModified: date(item.lastModified),
      createdAt: date(item.createdAt),
    }))
    .sort((a, b) => b.likes - a.likes)
    .slice(0, TOP);
}

export function createHuggingFace({ fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  async function getJson(path) {
    let response;
    try {
      response = await fetch(HOST + path, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError("PROVIDER_UNAVAILABLE", "Hugging Face is unavailable.");
    }
    if (response.status === 404) {
      await response.body?.cancel?.().catch(() => {});
      throw new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "Hugging Face account not found.", { status: 404 });
    }
    if (response.status === 429) {
      const delay = rateLimitDelay(response.headers) ?? 60;
      await response.body?.cancel?.().catch(() => {});
      throw new ProviderError("RATE_LIMITED", "Hugging Face rate limit reached.", { status: 429, retryAt: new Date(now() + (delay + 1) * 1000) });
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new ProviderError("PROVIDER_UNAVAILABLE", "Hugging Face is unavailable.", { status: response.status });
    }
    try {
      return JSON.parse(await readCapped(response));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("PROVIDER_UNAVAILABLE", "Hugging Face returned an unreadable response.");
    }
  }
  return {
    async fetchProfile(username) {
      if (typeof username !== "string" || !username) throw new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "Hugging Face account not found.");
      const user = encodeURIComponent(username);
      const overview = await getJson(`/api/users/${user}/overview`);
      if (!overview || typeof overview !== "object" || Array.isArray(overview))
        throw new ProviderError("PROVIDER_UNAVAILABLE", "Hugging Face returned an unexpected profile.");
      const list = (kind) => getJson(`/api/${kind}?author=${user}&sort=likes&direction=-1&limit=${TOP}`);
      const [models, datasets, spaces] = [await list("models"), await list("datasets"), await list("spaces")];
      return {
        account: { username: text(overview.user, 100) || username },
        counts: { models: count(overview.numModels), datasets: count(overview.numDatasets), spaces: count(overview.numSpaces) },
        top: { models: normalizeItems(models), datasets: normalizeItems(datasets), spaces: normalizeItems(spaces) },
      };
    },
  };
}
