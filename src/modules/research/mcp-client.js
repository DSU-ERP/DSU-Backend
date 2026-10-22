// MCP transport for web research (WEB_SEARCH_TRANSPORT=mcp): the backend calls
// the `web_search` tool of mcp/web-search-server.js over stdio.
//
// One child process is spawned and reused. A call that times out or loses the
// connection retires that process: the next call starts a fresh one, and the
// retired process is closed as soon as no other in-flight call still uses it.
// Every process is a numbered generation and a call only ever retires the
// generation it used, so a late failure can never close its replacement.
// A tool-level error (the providers themselves failed) leaves the healthy
// process running. Callers fall back to direct search when the MCP layer fails.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { cleanResults } from "./web-search.js";

export const MCP_SERVER_PATH = fileURLToPath(
  new URL("../../../mcp/web-search-server.js", import.meta.url),
);
// Only search settings reach the child; database and AI secrets never do.
const SECRETS = ["BRAVE_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "GOOGLE_SEARCH_CX"];
const FORWARDED = [...SECRETS, "WEB_SEARCH_PROVIDERS"];
const STDERR_LINE_LIMIT = 200;
const STDERR_LINES_PER_PROCESS = 20;

/** One JSON line on stderr, like the server's other operational events. */
export const logEvent = (event, fields = {}) =>
  console.error(JSON.stringify({ event, ...fields }));

/** A short, single-line excerpt of child stderr without search keys or query text. */
export function stderrLine(text, secrets = []) {
  let line = String(text ?? "");
  for (const secret of secrets)
    if (typeof secret === "string" && secret.length >= 4)
      line = line.split(secret).join("***");
  return line
    .replace(/([?&](?:key|cx|q)=)[^&\s"']+/gi, "$1***")
    .replace(/(x-subscription-token["']?\s*[:=]\s*["']?)[^\s"',;)\]}]+/gi, "$1***")
    .replace(/(bearer\s+)[^\s"',;)\]}]+/gi, "$1***")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, STDERR_LINE_LIMIT);
}

export async function connectStdio(
  env,
  { log = logEvent, args = [MCP_SERVER_PATH] } = {},
) {
  const childEnv = getDefaultEnvironment();
  for (const key of FORWARDED)
    if (typeof env[key] === "string" && env[key]) childEnv[key] = env[key];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnv,
    stderr: "pipe",
  });
  // The server never writes to stderr on purpose, so anything it does write
  // (a crash, a runtime warning) is logged as a few short, sanitised lines.
  const secrets = SECRETS.map((key) => childEnv[key]);
  let pending = "",
    logged = 0;
  const emit = (text) => {
    const line = stderrLine(text, secrets);
    if (line && logged < STDERR_LINES_PER_PROCESS) {
      logged++;
      log("mcp_web_search_stderr", { line });
    }
  };
  transport.stderr?.on("data", (chunk) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop().slice(-4096);
    lines.forEach(emit);
  });
  transport.stderr?.on("end", () => emit(pending));
  const client = new Client({ name: "dsu-backend", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function deadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("MCP web search did not start in time")),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The server answered, but the search itself failed (or the answer was unusable). */
export class McpToolError extends Error {}

/** Parses the tool result into the direct-search outcome shape, re-validating every result. */
export function toolOutcome(result) {
  if (result?.isError)
    throw new McpToolError("MCP web search tool reported an error");
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new McpToolError("MCP web search returned an unreadable result");
  }
  const results = cleanResults(data?.results);
  return {
    status: results.length ? "ok" : "no-results",
    provider: typeof data?.provider === "string" ? data.provider.slice(0, 20) : null,
    cached: false,
    results,
  };
}

export function createMcpSearch({
  env = process.env,
  connect = connectStdio,
  connectTimeoutMs = 6000,
  callTimeoutMs = 8000,
  log = logEvent,
} = {}) {
  let current = null,
    generation = 0,
    closed = false;
  const live = new Set();
  const dispose = (session) => {
    if (session.disposed) return;
    session.retired = session.disposed = true;
    session.done = session.ready
      .then((client) => client.close())
      .catch(() => {})
      .finally(() => live.delete(session));
  };
  const retire = (session, reason) => {
    if (session.retired) return;
    session.retired = true;
    if (current === session) current = null;
    log("mcp_web_search_restart", { generation: session.generation, reason });
    // Another in-flight call may still be using this process: close it last.
    if (!session.users) dispose(session);
  };
  const start = () => {
    const raw = Promise.resolve().then(() => connect(env, { log }));
    const session = {
      generation: ++generation,
      users: 0,
      retired: false,
      disposed: false,
      ready: deadline(raw, connectTimeoutMs),
      done: null,
    };
    session.ready.then(
      (client) => {
        // A child that exits or crashes on its own is replaced on the next call.
        const previous = client.onclose;
        client.onclose = () => {
          previous?.();
          retire(session, "exited");
        };
      },
      () => {
        retire(session, "connect");
        // A connection that completes after the timeout is closed, not leaked.
        raw.then((late) => late.close()).catch(() => {});
      },
    );
    live.add(session);
    return session;
  };
  return {
    async search(query, count) {
      if (closed) throw new Error("MCP web search is closed");
      const session = current || (current = start());
      session.users++;
      try {
        const client = await session.ready;
        let result;
        try {
          result = await client.callTool(
            { name: "web_search", arguments: { query, count } },
            undefined,
            { timeout: callTimeoutMs },
          );
        } catch (error) {
          retire(
            session,
            error?.code === ErrorCode.RequestTimeout ? "timeout" : "error",
          );
          throw error;
        }
        return toolOutcome(result);
      } finally {
        session.users--;
        if (session.retired && !session.users) dispose(session);
      }
    },
    /** Shutdown: closes every process, including retired ones still finishing a call. */
    async close() {
      closed = true;
      current = null;
      const sessions = [...live];
      sessions.forEach(dispose);
      await Promise.all(sessions.map((session) => session.done));
    },
    /** Generations with a running or closing process (diagnostics and tests). */
    get processes() {
      return [...live].map((session) => session.generation);
    },
  };
}
