# Web research (Observation Haki)

Observation Haki can ground answers in live web results and show the pages it
relied on. Research uses **official search APIs only**:

| Provider | Variables | Endpoint |
| --- | --- | --- |
| Brave Search API (**recommended**) | `BRAVE_SEARCH_API_KEY` | `https://api.search.brave.com/res/v1/web/search` |
| Google Programmable Search (Custom Search JSON API), existing customers only | `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` | `https://www.googleapis.com/customsearch/v1` |

Search result pages (google.com or any other site) are never scraped.

> **Google's Custom Search JSON API is closed to new customers.** Google's
> [overview page](https://developers.google.com/custom-search/v1/overview)
> says existing customers have until **1 January 2027** to move to another
> solution (Google suggests Vertex AI Search for searching up to 50 domains).
> New deployments should use Brave. A campus that already has a Google key can
> keep it as a fallback until then; after that date Google calls fail and are
> skipped, so remove the two Google variables.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRAVE_SEARCH_API_KEY` | empty | Brave subscription token (sent as the `X-Subscription-Token` header). |
| `GOOGLE_SEARCH_API_KEY`, `GOOGLE_SEARCH_CX` | empty | Google API key and Programmable Search Engine ID (existing Google customers only). Set both or neither. |
| `WEB_SEARCH_PROVIDERS` | `brave,google` | Order to try configured providers. A provider that fails, times out or returns nothing is skipped. |
| `WEB_SEARCH_TRANSPORT` | `direct` | `direct` calls the APIs in-process; `mcp` calls the `web_search` tool of the MCP server below. |

With no key configured, research is disabled: nothing is sent to any search
provider and the chat API reports `research: "unavailable"`.

Behaviour of every search (`src/modules/research/web-search.js`):

- 6 second timeout per provider, at most 5 results, India and English locale,
  safe search on. Queries are normalised and capped at 380 characters and 50
  words (Brave rejects more than 400 characters or 50 words).
- Brave parameters: `q`, `count=5` (Brave allows up to 20), `country=IN`,
  `search_lang=en`, `ui_lang=en-IN`, `safesearch=moderate`,
  `text_decorations=false`. `IN`, `en` and `en-IN` are values of Brave's
  documented `country`, `search_lang` and `ui_lang` lists.
- Google parameters: `key`, `cx`, `q`, `num=5` (1 to 10 allowed), `gl=in`
  (two-letter country code), `hl=en` (interface language), `safe=active`.
- Titles and snippets are reduced to plain text; only `http(s)` URLs without
  embedded credentials are kept; duplicates are removed.
- Results are cached in memory for 15 minutes, keyed by the normalised query.
- Errors carry a short code only. Keys, request URLs and queries are never logged.

## How the chat uses it

`POST /api/v1/student/conversations/:id/message` accepts `webSearch: true`
(the composer toggle). Drive comparisons search automatically unless the
student sends `webSearch: false`; their query contains only the company and
role, never student data. Each search counts against the student's AI request
budget (12 per minute). No search is made when the AI provider is not
configured (the request fails with `AI_NOT_CONFIGURED`), because only an AI
answer would use the results.

The model receives numbered results without URLs and returns
`citations: number[]` (indexes into that list). The server keeps at most five
in-range, distinct indexes and builds `sources` (`title`, `url`, `description`,
`domain`) from its own results, so a model can never introduce a link. Sources
are stored in `student.messages.sources`.

Response field `research`: `off`, `used`, `no-results`, `failed`,
`unavailable` or `skipped` (a drive comparison waiting for a resume).

Requested searches also return `researchInfo` with the actual query, result
count and validated search results for the fresh reply. The UI distinguishes
these retrieved pages from the answer's cited sources. Short retries such as
"give ans", "answer this" or "search again" reuse the last meaningful user
topic rather than searching those generic words. The model receives the search
status explicitly and must use relevant supplied evidence instead of claiming
it has no web access. A careers portal is not proof of an individual vacancy.

Search remains opt-in. The browser remembers the student's explicit toggle
choice across new chats/reloads, and can recheck availability after a backend
restart without discarding the draft. Drive comparisons still search only
company/role context. `researchInfo` is fresh-response metadata; saved message
history retains its validated cited sources as before.

`node --env-file-if-exists=.env scripts/verify-haki-research-live.js --live`
explicitly checks search, the actual Haki prompt/schema, citation mapping and
the saved-response path with generic careers text and an in-memory SQL
stand-in. It makes a paid AI request but reads/writes no real student account
or database records.

## MCP server

`mcp/web-search-server.js` is a stdio MCP server (official
`@modelcontextprotocol/sdk`) exposing one read-only tool:

- `web_search` — `{ query: string (1–380 chars), count?: 1–5 }`. Returns a text
  block with `{"status","provider","results":[{"title","url","description"}]}`,
  or `isError: true` with a plain message when search is not configured or the
  providers fail.

Run it with the keys from `.env`:

```sh
npm run mcp:web-search
```

Example client configuration (Claude Desktop, Claude Code `.mcp.json` or any
MCP client). Use an absolute path to this repository and keep keys in the
client's secret store or environment, never in a committed file:

```json
{
  "mcpServers": {
    "dsu-web-search": {
      "command": "node",
      "args": ["/absolute/path/to/backend/mcp/web-search-server.js"],
      "env": {
        "BRAVE_SEARCH_API_KEY": "${BRAVE_SEARCH_API_KEY}",
        "WEB_SEARCH_PROVIDERS": "brave"
      }
    }
  }
}
```

### Backend MCP transport (`WEB_SEARCH_TRANSPORT=mcp`)

- The backend spawns this server with `process.execPath` and passes it only
  the four search variables above (no database or AI secrets). One process is
  reused for every search.
- Starting the server may take up to 6 s. A call may take up to 6 s per
  configured provider plus 2 s, so a slow provider is not mistaken for a stuck
  process.
- A call that times out or loses the connection, and a process that exits on
  its own, retire that process: the next search starts a fresh one. A retired
  process is closed once no other in-flight search still uses it. Processes
  are numbered generations and a search only ever retires the one it used,
  so a late failure never closes its replacement.
- When the MCP layer fails (spawn, crash, timeout), that search falls back to
  the direct call. When the server answered that its providers failed, the
  search reports `failed` without repeating the same provider calls.
- Anything the server writes to stderr is logged as short JSON lines
  (`{"event":"mcp_web_search_stderr","line":...}`, at most 20 lines of 200
  characters per process) with search keys and query text removed. Restarts
  are logged as `{"event":"mcp_web_search_restart","generation":n,"reason":...}`.
- Shutdown (`app.close()`) closes every process, including retired ones that
  are still finishing a call.

The Docker image includes the `mcp/` folder for this mode.

## Tests

`test/web-search.test.js` (provider order, caching, timeouts, query limits,
no-key behaviour, citation mapping, MCP fallback rules) and
`test/mcp-web-search.test.js` (tool listing and calls in-process; generation
and in-flight lifecycle; stderr logging; timeouts, restarts and shutdown over
real stdio children, checking that no process is left running) stub every
network call.
