# Agent workflow visualization

The Admin portal (`/admin/agent-workflow` in the web app) shows how F.R.I.D.A.Y. handles requests. It is built from real execution traces, not a hand-drawn diagram.

- **Architecture** draws each assistant's real pipeline.
- **Execution** shows recorded runs: which steps ran, in what order, how long each took, which tools were called, where a run failed, and where an authorization check refused it.

## 1. Existing agent architecture

LangChain, LangGraph and LangSmith are **not** used. Neither repository installs them. All three assistants use custom orchestration over OpenRouter.

| Assistant | Runs in | Shape |
| --- | --- | --- |
| Placement Officer | Web app, `src/app/placement/friday-api/route.ts` and `src/features/assistant/lib/engine.ts`, streamed over server-sent events | A tool-calling loop. The model chooses from the read-only tools in `tools.ts`, plus the competency tools when testing is on. Every tool re-checks the officer in the database. There are at most 4 tool rounds. |
| Student | Backend, `src/modules/students/chat.js`, one request | A fixed pipeline: identity under row-level security, then own context, a route decision, optional web search, optional competency context, one schema-checked model call, and a save. The model cannot choose data sources. |
| Company | Backend, `src/modules/company/friday.js`, one request | A fixed pipeline: company membership, then `company.*` database functions scoped to the member's own company, one schema-checked model call, and a save. |

We decided not to migrate to LangGraph. There is one small loop and two linear pipelines. A second framework would add a dependency without an architectural benefit, so the existing code is instrumented directly.

## 2. How the graph is generated

- **Student and company.** `DSU-Backend/src/modules/ops/workflows.js` declares the nodes and edges, served by `GET /admin/agent-workflows`. Node ids are exactly the step names the tracer records. `test/agent-traces.integration.test.js` fails if a recorded step is not declared, so the diagram cannot drift from the code.
- **Officer.** `DSU_ERP/src/features/admin/lib/officer-workflow.ts` builds the graph from the engine's real tool list (`FRIDAY_TOOLS`, `COMPETENCY_TOOLS`) and its round limit. Adding a tool adds its node.
- **Layout and run state.** `DSU_ERP/src/features/admin/lib/graph.ts` holds pure functions, unit-tested in `tests/agent-graph.test.ts`:
  - Nodes are laid out by their longest path from the input.
  - Nested steps (database calls, tools) sit beside their parent.
  - A node's state is the worst status of its recorded steps.
  - An edge counts as taken only between consecutively executed nodes. Where that gap passes through steps the run skipped, the shortest route through those skipped nodes is used.
- **Rendering.** React Flow (`@xyflow/react` 12.12.0) draws the graph, with zoom, pan, drag, fit to screen, click to inspect, and expand or collapse for nested steps.

## 3. How trace events are captured

- **Backend** (`src/modules/ops/tracer.js`). Each message creates a run with a UUID. `tracer.step()` times real code and records its outcome:
  - completed;
  - failed, with an error category;
  - denied, when the failure is a 401 or 403.

  `tracer.record()` captures a decision or a skipped branch. `tracer.open()` starts a parent step so its children can nest under it. The shared model client (`ai.js`) records three spans: the AI request limit, the provider call (with token counts when the provider returns them) and the response schema check.
- **Officer** (`DSU_ERP/src/features/admin/lib/officer-trace.ts`). The engine receives an optional trace and records each model round, each tool round, and each tool nested under its round. The route records identity, the request limit, the conversation load, the streamed output and the save. Steps are sent to `POST /ops/traces/:id/steps` after every tool round and at the end, through a chained, unawaited queue.
- **Cost.** Backend runs make two short database calls: start, then finish with every step. Officer runs make one HTTP call per tool round. A trace failure turns tracing off for that run and never fails or delays the answer.
- **Honesty.** Timings are real timestamps. A value the code does not have is shown as "Not available", never estimated. This applies to token counts the provider did not return, timing of a step recorded as a decision, and the answer text, which is never stored.

## 4. Nested runs and tool calls

`parent_seq` links a step to its parent:

- Student: context, then own placement and schedule.
- Company: context, then each `company.*` database call (one `company.applicants` call per released drive).
- Officer: tool round, then each tool.

In a run, groups with executed children open automatically and list only the children that ran. In Architecture mode, every child is listed.

## 5. Storage, retention and privacy

The migration is `202611020001_agent_traces.sql`, in schema `ops`.

| Table | Holds |
| --- | --- |
| `ops.admins` | The dedicated admin list. It grants only the Admin portal and traces, no student, officer or company data. |
| `ops.agent_runs` | Assistant, workflow version, the caller's real role (worked out in the database, never sent by the caller), company id for company runs, status, timings, error category, and a small summary such as message length. `actor_id` is kept only to stop other accounts appending steps; it is never returned to the portal. |
| `ops.agent_steps` | Node, kind, label, status, timestamps, attempt, error category, and allowlisted metadata (2 KB maximum). |

**Never stored:** prompts, the question text, answers, tool arguments, tool results, student records, resumes, contact details or credentials.

Metadata passes an allowlist twice: in the tracer (`safeMeta`), and again in the officer intake route. Values are short strings, numbers or booleans: tool name, row counts, decision, model id, token counts, HTTP status. Errors are stored as a category such as `forbidden`, `timeout` or `model_provider`, never as the message.

**Retention:** every run expires 7 days after it starts. Expired runs are hidden at once, and deleted in batches of up to 500 whenever a new run starts.

**External services:** none. No trace leaves our database.

## 6. Access control

- Only active accounts on `ops.admins` can read traces. `ops.assert_admin()` runs inside every read function (`ops.agent_runs_list`, `ops.agent_run`) and in `GET /admin/session` and `GET /admin/agent-workflows`. The API role has no direct table access.
- Students, officers and companies get 403 on every admin endpoint. Removing someone from the list takes effect immediately.
- The web proxy `/admin/api/...` forwards only trace reads; the backend checks the list again on every one.
- **Writes.** Backend runs are written by the backend itself. The officer intake (`POST /ops/traces`) requires a placement officer. Only the account that started a run can add steps, and a finished run cannot be changed.
- **Tenant isolation.** A company account has no access to any trace, including its own company's. Company runs show the company name to admins only.

Add or remove an admin with an operator connection. The account must already exist.

```
npm run access:admin -- person@example.com
npm run access:admin -- person@example.com --revoke
```

## 7. Using the visualizer

1. Sign in with an admin account. `/session` sends admin-only accounts to `/admin`.
2. Open **Agent workflow**.
3. Choose an assistant, then **Architecture** or **Execution**.
4. In Execution, filter by status, tool and time range, then pick a run.
   - **Live updates** polls every 2 seconds while the tab is visible.
   - **Follow newest run** jumps to each new run as it appears.
5. Click any node for its purpose, code, inputs and outputs, outgoing edges and, in a run, its recorded steps. These show status, start, end, duration, attempt, error category, safe metadata and the next executed step.
6. **Replay** steps through the recorded order. Steps after the cursor show as pending. **Reset** returns to the full run.

## 8. Debugging a failed execution

- The summary shows the run's error category.
- The red node and the highlighted edge to **Run failed** or **Access denied** mark where it stopped.
- **Errors and denials** lists each failing step with its category.

| Category | Usual cause |
| --- | --- |
| `model_provider` | OpenRouter refused or failed. Check the key, credits and provider routing. |
| `timeout` | The provider or a tool took too long. |
| `invalid_model_output` | The answer failed the schema. Nothing was invented or saved. |
| `rate_limited` | The per-user AI budget or the officer request limit was reached. |
| `forbidden` / denied | The real authorization check refused the account (wrong role, not a member). |
| `tool_error`, `invalid_arguments` | An officer tool failed or the model sent bad arguments. |
| `loop_limit` | The officer assistant used all 4 tool rounds. |

## 9. Known limitations

- **Student and company steps appear when the run ends.** These requests take a few seconds; the run shows as Running until then. Officer runs update after every tool round.
- **Denials before a role check.** Officer FRIDAY is reachable only by officers, so a non-officer's attempt is refused by the page before a trace exists. Student and company denials are recorded.
- **Refusing off-topic questions is model behaviour.** A student asking for another student's CGPA shows the identity step as completed, scoped to their own records only. No denied database call appears, because none is attempted: the pipeline never loads anyone else's data. The model's refusal is in the answer, which is not stored.
- **Missing values.** Token counts appear only when the provider returns them. The model's internal reasoning is never captured or shown.
- **Write limits.** Up to 60 runs per account per minute and 100 steps per run are kept. Beyond that, tracing stops quietly; the answer is unaffected.
- **Clocks.** Officer timings come from the web server's clock and backend timings from the backend's clock.

## 10. Tests

- **Backend:** `test/agent-traces.integration.test.js` covers step order, skipped branches, model failures, denials, nested company calls, admin-only reads, write protection, metadata allowlisting and expiry.
- **Web:** `tests/agent-graph.test.ts` covers layout, taken edges, the officer loop, terminal states and replay. `scripts/verify-agent-workflow-ui.cjs` (`npm run test:agent-workflow-ui`) renders the page in a browser with synthetic runs in both themes from 1440 to 390 px.
