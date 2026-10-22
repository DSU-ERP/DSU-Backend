import {
  createWebSearch,
  safeUrl,
  domainOf,
  normalizeQuery,
  resultLimit,
  MAX_RESULTS,
  SEARCH_TIMEOUT_MS,
} from "./web-search.js";
import { createMcpSearch, McpToolError } from "./mcp-client.js";

export const MAX_CITATIONS = 5;

/**
 * Web research used by Observation Haki. WEB_SEARCH_TRANSPORT=mcp routes calls
 * through the stdio MCP server; when the MCP layer fails (spawn, crash,
 * timeout) the call falls back to the direct search. When the MCP server
 * answered that its providers failed, the same calls are not repeated.
 * With no configured provider, `enabled` is false and nothing is sent anywhere.
 */
export function createResearch({ env = process.env, fetch, mcp, log } = {}) {
  const direct = createWebSearch({ env, ...(fetch ? { fetch } : {}) });
  if (!direct.enabled || env.WEB_SEARCH_TRANSPORT !== "mcp")
    return {
      enabled: direct.enabled,
      transport: "direct",
      providers: direct.providers,
      search: direct.search,
      close: async () => {},
    };
  const viaMcp =
    mcp ||
    createMcpSearch({
      env,
      // The server tries each provider with its own timeout; waiting for all of
      // them keeps a slow provider from being mistaken for a stuck process.
      callTimeoutMs: SEARCH_TIMEOUT_MS * direct.providers.length + 2000,
      ...(log ? { log } : {}),
    });
  return {
    enabled: true,
    transport: "mcp",
    providers: direct.providers,
    async search(query, count = MAX_RESULTS) {
      // The tool accepts the same normalised query the direct search sends.
      const q = normalizeQuery(query),
        limit = resultLimit(count);
      if (!q)
        return { status: "no-results", provider: null, cached: false, results: [], transport: "mcp" };
      try {
        return { ...(await viaMcp.search(q, limit)), transport: "mcp" };
      } catch (error) {
        if (error instanceof McpToolError)
          return { status: "failed", provider: null, cached: false, results: [], transport: "mcp" };
        return { ...(await direct.search(q, limit)), transport: "direct" };
      }
    },
    close: () => viaMcp.close(),
  };
}

/**
 * Builds sources from the model's citation indexes. Only indexes that point at
 * a supplied research result are used, so the model can never introduce a URL.
 */
export function citedSources(citations, research) {
  const sources = [],
    used = new Set();
  for (const index of Array.isArray(citations) ? citations : []) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= research.length ||
      used.has(index)
    )
      continue;
    used.add(index);
    const item = research[index],
      url = safeUrl(item?.url);
    if (!url) continue;
    sources.push({
      title: String(item.title || domainOf(url)).slice(0, 200),
      url,
      description: String(item.description || "").slice(0, 400),
      domain: domainOf(url),
    });
    if (sources.length === MAX_CITATIONS) break;
  }
  return sources;
}

/** What the model sees: numbered results without URLs. */
export function researchForModel(research) {
  return research.map((item, index) => ({
    index,
    title: item.title,
    site: domainOf(item.url),
    snippet: item.description,
  }));
}
