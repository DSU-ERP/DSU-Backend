import test from "node:test";
import assert from "node:assert/strict";
import {
  createWebSearch,
  providerOrder,
  plainText,
  safeUrl,
  normalizeQuery,
  CACHE_TTL_MS,
} from "../src/modules/research/web-search.js";
import {
  createResearch,
  citedSources,
  researchForModel,
} from "../src/modules/research/index.js";
import { McpToolError } from "../src/modules/research/mcp-client.js";

const keys = {
  BRAVE_SEARCH_API_KEY: "brave-secret",
  GOOGLE_SEARCH_API_KEY: "google-secret",
  GOOGLE_SEARCH_CX: "engine",
};
const braveBody = {
  web: {
    results: [
      { title: "<strong>Acme</strong> careers &amp; hiring", url: "https://acme.example/careers", description: "Campus <b>drive</b> &#8377; details" },
      { title: "Bad scheme", url: "javascript:alert(1)", description: "x" },
      { title: "Creds", url: "https://user:pw@evil.example/", description: "x" },
      { title: "Duplicate", url: "https://acme.example/careers", description: "dup" },
      ...Array.from({ length: 6 }, (_, i) => ({ title: "R" + i, url: `https://r${i}.example/`, description: "" })),
    ],
  },
};
const googleBody = {
  items: [{ title: "Google result", link: "https://g.example/a", snippet: "From <em>Google</em>" }],
};
function stubFetch(handlers) {
  const calls = [];
  const fetch = async (url, options) => {
    const target = new URL(url);
    calls.push({ url: target, options });
    const handler = handlers[target.hostname];
    if (!handler) throw new Error("unexpected host " + target.hostname);
    return handler(target, options);
  };
  return { fetch, calls };
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test("no configured provider disables research without any network call", async () => {
  const { fetch, calls } = stubFetch({});
  const search = createWebSearch({ env: {}, fetch });
  assert.equal(search.enabled, false);
  assert.deepEqual(await search.search("acme hiring"), {
    status: "unavailable",
    provider: null,
    cached: false,
    results: [],
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(providerOrder({ GOOGLE_SEARCH_API_KEY: "k" }), []); // CX is required too
  assert.equal(createResearch({ env: {} }).enabled, false);
});

test("providers follow WEB_SEARCH_PROVIDERS order and fall back on failure", async () => {
  assert.deepEqual(providerOrder(keys), ["brave", "google"]);
  assert.deepEqual(providerOrder({ ...keys, WEB_SEARCH_PROVIDERS: " Google ,brave,bing" }), ["google", "brave"]);
  const { fetch, calls } = stubFetch({
    "www.googleapis.com": () => ({ ok: false, status: 500, text: async () => "" }),
    "api.search.brave.com": () => ok(braveBody),
  });
  const search = createWebSearch({ env: { ...keys, WEB_SEARCH_PROVIDERS: "google,brave" }, fetch });
  const outcome = await search.search("  Acme   hiring\u0000process ");
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.provider, "brave");
  assert.deepEqual(calls.map((c) => c.url.hostname), ["www.googleapis.com", "api.search.brave.com"]);
  // Official endpoints only, India locale, at most five results.
  const [google, brave] = calls;
  assert.equal(google.url.pathname, "/customsearch/v1");
  assert.equal(google.url.searchParams.get("gl"), "in");
  assert.equal(google.url.searchParams.get("num"), "5");
  assert.equal(google.url.searchParams.get("q"), "Acme hiring process");
  assert.equal(brave.url.searchParams.get("country"), "IN");
  assert.equal(brave.url.searchParams.get("count"), "5");
  assert.equal(brave.options.headers["X-Subscription-Token"], "brave-secret");
  assert.ok(calls.every((c) => !/(^|\.)google\.com$/.test(c.url.hostname)));
  // Sanitised: plain text, http(s) only, no credentials, de-duplicated, capped.
  assert.equal(outcome.results.length, 5);
  assert.deepEqual(outcome.results[0], {
    title: "Acme careers & hiring",
    url: "https://acme.example/careers",
    description: "Campus drive ₹ details",
  });
  assert.ok(outcome.results.every((r) => /^https?:\/\//.test(r.url) && !r.url.includes("@")));
  assert.equal((await search.search("acme hiring process", 2)).results.length, 2);
});

test("results are cached for fifteen minutes by normalised query", async () => {
  let clock = 1_000_000;
  const { fetch, calls } = stubFetch({ "api.search.brave.com": () => ok(braveBody) });
  const search = createWebSearch({ env: { BRAVE_SEARCH_API_KEY: "k" }, fetch, now: () => clock });
  await search.search("Acme Hiring");
  const cached = await search.search("  acme   hiring ");
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 1);
  clock += CACHE_TTL_MS + 1;
  assert.equal((await search.search("acme hiring")).cached, false);
  assert.equal(calls.length, 2);
});

test("a provider that does not answer in time is abandoned", async () => {
  let aborted = false;
  const { fetch } = stubFetch({
    "api.search.brave.com": (_url, { signal }) =>
      new Promise(() => signal.addEventListener("abort", () => (aborted = true))),
    "www.googleapis.com": () => ok(googleBody),
  });
  const search = createWebSearch({ env: keys, fetch, timeoutMs: 30 });
  const outcome = await search.search("acme");
  assert.equal(aborted, true);
  assert.equal(outcome.provider, "google");
  assert.equal(outcome.results[0].description, "From Google");
  const lonely = createWebSearch({
    env: { BRAVE_SEARCH_API_KEY: "brave-secret" },
    fetch: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  const failed = await lonely.search("acme");
  assert.equal(failed.status, "failed");
  assert.ok(!JSON.stringify(failed).includes("secret"));
  const empty = createWebSearch({ env: { BRAVE_SEARCH_API_KEY: "k" }, fetch: async () => ok({ web: { results: [] } }) });
  assert.equal((await empty.search("nothing")).status, "no-results");
});

test("citations map only to supplied research results", () => {
  const research = [
    { title: "A", url: "https://www.a.example/x", description: "first" },
    { title: "B", url: "https://b.example/", description: "second" },
  ];
  const sources = citedSources([1, 7, -1, 0, 1, 1.5, "0", 99], research);
  assert.deepEqual(sources.map((s) => s.url), ["https://b.example/", "https://www.a.example/x"]);
  assert.equal(sources[1].domain, "a.example");
  assert.deepEqual(citedSources(undefined, research), []);
  assert.deepEqual(citedSources([0], []), []);
  const many = Array.from({ length: 8 }, (_, i) => ({ title: "T", url: `https://s${i}.example/`, description: "" }));
  assert.equal(citedSources([0, 1, 2, 3, 4, 5, 6, 7], many).length, 5);
  // The model sees numbered snippets, never URLs to copy.
  assert.deepEqual(researchForModel(research)[0], { index: 0, title: "A", site: "a.example", snippet: "first" });
});

test("MCP transport falls back to the direct call when the MCP server fails", async () => {
  const { fetch, calls } = stubFetch({ "api.search.brave.com": () => ok(braveBody) });
  let closed = 0;
  const research = createResearch({
    env: { BRAVE_SEARCH_API_KEY: "k", WEB_SEARCH_TRANSPORT: "mcp" },
    fetch,
    mcp: { search: async () => { throw new Error("spawn failed"); }, close: async () => { closed++; } },
  });
  assert.equal(research.transport, "mcp");
  const outcome = await research.search("acme");
  assert.equal(outcome.transport, "direct");
  assert.equal(outcome.status, "ok");
  assert.equal(calls.length, 1);
  await research.close();
  assert.equal(closed, 1);
});

test("queries respect Brave's limits and the MCP tool gets the same normalised query", async () => {
  const long = Array.from({ length: 80 }, (_, i) => "word" + i).join("  ");
  assert.equal(normalizeQuery(long).split(" ").length, 50);
  assert.ok(normalizeQuery("x".repeat(1000)).length <= 380);
  const seen = [];
  const { fetch, calls } = stubFetch({ "api.search.brave.com": () => ok(braveBody) });
  const research = createResearch({
    env: { BRAVE_SEARCH_API_KEY: "k", WEB_SEARCH_TRANSPORT: "mcp" },
    fetch,
    mcp: {
      search: async (query, count) => {
        seen.push({ query, count });
        throw new McpToolError("providers failed");
      },
      close: async () => {},
    },
  });
  // The server already tried every provider: the same calls are not repeated in-process.
  const failed = await research.search(long + "\u0000", 99);
  assert.deepEqual({ status: failed.status, transport: failed.transport }, { status: "failed", transport: "mcp" });
  assert.equal(calls.length, 0);
  assert.deepEqual(seen, [{ query: normalizeQuery(long), count: 5 }]);
  assert.equal((await research.search("   ")).status, "no-results");
  assert.equal(seen.length, 1);
});

test("text and URL helpers reject unsafe input", () => {
  assert.equal(plainText("<script>x</script>&lt;b&gt;bold&lt;/b&gt; &#0; &#x110000;"), "x bold");
  assert.equal(safeUrl("ftp://a.example/"), null);
  assert.equal(safeUrl("data:text/html,hi"), null);
  assert.equal(safeUrl("https://a.example/" + "x".repeat(3000)), null);
  assert.equal(safeUrl("http://a.example/p?q=1"), "http://a.example/p?q=1");
});

test("search settings are validated without echoing their values", async () => {
  const { readEnv } = await import("../src/config/env.js");
  const valid = { DATABASE_URL: "postgresql://dsu_api:secret@localhost/erp", SUPABASE_URL: "https://test.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SERVICE_TOKEN: "x".repeat(32) };
  const env = readEnv({ ...valid, BRAVE_SEARCH_API_KEY: "", WEB_SEARCH_TRANSPORT: "" });
  assert.equal(env.WEB_SEARCH_PROVIDERS, "brave,google");
  assert.equal(env.WEB_SEARCH_TRANSPORT, "direct");
  assert.equal(env.BRAVE_SEARCH_API_KEY, undefined);
  assert.throws(() => readEnv({ ...valid, WEB_SEARCH_PROVIDERS: "brave,scraper" }), /WEB_SEARCH_PROVIDERS/);
  assert.throws(() => readEnv({ ...valid, WEB_SEARCH_TRANSPORT: "http" }), /WEB_SEARCH_TRANSPORT/);
  try {
    readEnv({ ...valid, GOOGLE_SEARCH_API_KEY: "google-key-that-must-not-leak" });
    assert.fail("expected the missing engine ID to be reported");
  } catch (error) {
    assert.match(error.message, /GOOGLE_SEARCH_CX/);
    assert.ok(!error.message.includes("google-key-that-must-not-leak"));
  }
});
