import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWebSearchServer } from "../mcp/web-search-server.js";
import {
  connectStdio,
  createMcpSearch,
  toolOutcome,
  stderrLine,
  McpToolError,
} from "../src/modules/research/mcp-client.js";

async function inMemoryClient(search) {
  const server = createWebSearchServer(search);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}
const stub = (outcome, seen = []) => ({
  search: async (query, count) => {
    seen.push({ query, count });
    return outcome;
  },
});

test("the MCP server lists and runs the web_search tool", async () => {
  const seen = [];
  const client = await inMemoryClient(
    stub(
      {
        status: "ok",
        provider: "brave",
        results: [{ title: "Acme", url: "https://acme.example/", description: "Hiring" }],
      },
      seen,
    ),
  );
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["web_search"]);
  const schema = tools[0].inputSchema;
  assert.deepEqual(schema.required, ["query"]);
  assert.equal(schema.properties.count.maximum, 5);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const result = await client.callTool({ name: "web_search", arguments: { query: "acme hiring", count: 3 } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).results[0].url, "https://acme.example/");
  assert.deepEqual(seen, [{ query: "acme hiring", count: 3 }]);
  const tooMany = await client.callTool({ name: "web_search", arguments: { query: "acme", count: 9 } });
  assert.equal(tooMany.isError, true);
  assert.equal(seen.length, 1);
  await client.close();
});

test("the MCP server reports unconfigured search honestly", async () => {
  const client = await inMemoryClient(stub({ status: "unavailable", provider: null, results: [] }));
  const result = await client.callTool({ name: "web_search", arguments: { query: "acme" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not configured/);
  await client.close();
});

test("the backend MCP client reuses one session and re-validates results", async () => {
  let connects = 0;
  const search = createMcpSearch({
    env: {},
    connect: async () => {
      connects++;
      return inMemoryClient(
        stub({
          status: "ok",
          provider: "google",
          results: [
            { title: "<b>Safe</b>", url: "https://safe.example/", description: "ok" },
            { title: "Unsafe", url: "javascript:alert(1)", description: "x" },
          ],
        }),
      );
    },
  });
  const first = await search.search("acme", 5);
  await search.search("acme again", 5);
  assert.equal(connects, 1);
  assert.deepEqual(first.results, [{ title: "Safe", url: "https://safe.example/", description: "ok" }]);
  await search.close();
  assert.throws(() => toolOutcome({ isError: true, content: [] }), McpToolError);
  assert.throws(() => toolOutcome({ content: [{ type: "text", text: "not json" }] }), McpToolError);
  const failing = createMcpSearch({ env: {}, log: () => {}, connect: async () => { throw new Error("no server"); } });
  await assert.rejects(() => failing.search("acme", 5));
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const okResult = {
  content: [{ type: "text", text: JSON.stringify({ status: "ok", provider: "brave", results: [{ title: "A", url: "https://a.example/", description: "" }] }) }],
};
// A fake client whose calls stay pending until the test settles them.
function fakeClients() {
  const clients = [];
  const connect = async () => {
    const client = {
      calls: [],
      closed: 0,
      onclose: undefined,
      callTool: () => new Promise((resolve, reject) => client.calls.push({ resolve, reject })),
      close: async () => {
        client.closed++;
      },
    };
    clients.push(client);
    return client;
  };
  return { clients, connect };
}

test("a failed call retires only its own process, after every in-flight call on it", async () => {
  const { clients, connect } = fakeClients();
  const events = [];
  const search = createMcpSearch({ env: {}, connect, log: (event, fields) => events.push({ event, ...fields }) });
  const a = search.search("a", 5),
    b = search.search("b", 5);
  await tick();
  assert.equal(clients.length, 1); // one process for both calls
  clients[0].calls[0].reject(Object.assign(new Error("Request timed out"), { code: -32001 }));
  await assert.rejects(a);
  assert.equal(clients[0].closed, 0); // b still uses generation 1
  assert.deepEqual(events, [{ event: "mcp_web_search_restart", generation: 1, reason: "timeout" }]);
  const c = search.search("c", 5);
  await tick();
  assert.equal(clients.length, 2); // new calls get a fresh process
  clients[0].calls[1].reject(new Error("Connection closed")); // b fails late on generation 1
  await assert.rejects(b);
  await tick();
  assert.equal(clients[0].closed, 1); // closed once its last call finished
  assert.equal(clients[1].closed, 0); // the replacement is untouched by b's failure
  clients[1].calls[0].resolve(okResult);
  assert.equal((await c).status, "ok");
  // A tool-level error means the providers failed, not the process: keep it.
  const d = search.search("d", 5);
  await tick();
  clients[1].calls[1].resolve({ isError: true, content: [{ type: "text", text: "failed" }] });
  await assert.rejects(d, McpToolError);
  const e = search.search("e", 5);
  await tick();
  assert.equal(clients.length, 2);
  clients[1].calls[2].resolve(okResult);
  await e;
  // A process that exits on its own is replaced by the next call.
  clients[1].onclose();
  await tick();
  assert.equal(clients[1].closed, 1);
  const f = search.search("f", 5);
  await tick();
  assert.equal(clients.length, 3);
  // Shutdown closes processes that still have calls in flight.
  await search.close();
  assert.equal(clients[2].closed, 1);
  assert.deepEqual(search.processes, []);
  clients[2].calls[0].reject(new Error("Connection closed"));
  await assert.rejects(f);
  await assert.rejects(search.search("g", 5), /closed/);
  assert.equal(clients.length, 3);
});

test("child stderr is logged as short lines without keys or query text", () => {
  const line = stderrLine(
    "Error: GET https://www.googleapis.com/customsearch/v1?key=AIzaSecret123&cx=engine-1&q=my+private+question failed\n    at fetch (x-subscription-token: BSAtoken9)",
    ["AIzaSecret123", "BSAtoken9", ""],
  );
  assert.equal(
    line,
    "Error: GET https://www.googleapis.com/customsearch/v1?key=***&cx=***&q=*** failed at fetch (x-subscription-token: ***)",
  );
  assert.equal(stderrLine("x".repeat(500)).length, 200);
  assert.equal(stderrLine("Bearer abc.def-ghi"), "Bearer ***");
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function exited(pid, ms = 8000) {
  for (const started = Date.now(); Date.now() - started < ms; ) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

test("the stdio server starts and answers over a real child process", { timeout: 30000 }, async () => {
  const client = await connectStdio({}); // no keys: the tool must say so
  const pid = client.transport.pid;
  try {
    const { tools } = await client.listTools();
    assert.equal(tools[0].name, "web_search");
    const result = await client.callTool({ name: "web_search", arguments: { query: "acme" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not configured/);
  } finally {
    await client.close();
  }
  assert.ok(await exited(pid));
});

test("a child's stderr reaches the log as sanitised lines", { timeout: 30000 }, async () => {
  const lines = [];
  // The real server, preceded by stderr output that includes a configured key,
  // as a failing dependency or a runtime warning might print.
  const noisy = `
    process.stderr.write("Warning: provider rejected token " + process.env.BRAVE_SEARCH_API_KEY + "\\n\\u0007second\\tline\\n");
    const { StdioServerTransport } = await import(${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))});
    const { createWebSearchServer } = await import(${JSON.stringify(new URL("../mcp/web-search-server.js", import.meta.url).href)});
    await createWebSearchServer().connect(new StdioServerTransport());`;
  const client = await connectStdio(
    { BRAVE_SEARCH_API_KEY: "brave-secret-key", DATABASE_URL: "postgres://not-forwarded" },
    {
      log: (event, fields) => event === "mcp_web_search_stderr" && lines.push(fields.line),
      args: ["--input-type=module", "-e", noisy],
    },
  );
  const pid = client.transport.pid;
  try {
    for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(lines, ["Warning: provider rejected token ***", "second line"]);
  } finally {
    await client.close();
  }
  assert.ok(await exited(pid));
});

test("real child processes: a timed-out call kills its process, tool errors keep it, shutdown leaves none", { timeout: 60000 }, async () => {
  const pids = [];
  const connect = async (env, options) => {
    const client = await connectStdio(env, options);
    pids.push(client.transport.pid);
    return client;
  };
  const events = [];
  const log = (event, fields) => events.push({ event, ...fields });
  // Every call times out (1 ms): each one is killed and the next call respawns.
  const slow = createMcpSearch({ env: {}, connect, log, callTimeoutMs: 1 });
  await assert.rejects(slow.search("acme", 5));
  assert.ok(await exited(pids[0]));
  await assert.rejects(slow.search("acme", 5));
  assert.equal(pids.length, 2);
  assert.notEqual(pids[1], pids[0]);
  assert.ok(await exited(pids[1]));
  await slow.close();
  assert.deepEqual(events.map((e) => e.reason), ["timeout", "timeout"]);
  // No keys in the child: the tool reports an error, the process stays and is reused.
  const healthy = createMcpSearch({ env: {}, connect, log });
  await assert.rejects(healthy.search("acme", 5), McpToolError);
  await assert.rejects(healthy.search("acme", 5), McpToolError);
  assert.equal(pids.length, 3);
  assert.ok(alive(pids[2]));
  await healthy.close();
  assert.ok(!alive(pids[2]));
  assert.equal(events.length, 2);
});
