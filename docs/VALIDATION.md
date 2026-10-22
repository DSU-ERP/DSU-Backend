# Backend validation

## Interview security for both modes — 22 October 2026

- Integrity warnings now apply to coached/mock and proctored interviews. Added restricted-window coverage, context-menu, drag/drop, navigation and picture-in-picture event kinds. New extra-display events are warnings. Inactivity remains informational; explicitly stored older informational events keep their original severity.
- Optional validated incident UUIDs are stored with integrity events. A retry of the same incident returns the existing count even outside the three-second debounce window. Only the server chooses severity, and the existing owned-row lock, third-warning finalization, answer persistence and report authorization remain enforced. No migration or media upload/recording was introduced.
- Interview and student integration suites: **22 checks passed**, including both-mode termination, paused incident retry idempotence, server-assigned severity, unsupported event rejection, private reports, current question ordering and student/officer boundaries. Frontend checks cover the actual permission/pause/resume logic using synthetic browser/device state; OS lockdown and real physical-device detection are not claimed.

## Haki web-search response flow — 22 October 2026

- Live Brave connection checks returned five results for generic Infosys careers queries, including official portals. The provider key/connection worked during diagnosis. Fixed generic search retries using their original user topic, made the model's search status explicit, and returned safe query/result metadata distinct from cited sources. Search opt-in, drive-only company/role queries and citation validation remain enforced.
- A live synthetic request through the actual Haki route/prompt/schema retrieved five pages and cited four official Infosys domains in 10.6 seconds. The answer distinguished careers portals from individual vacancy evidence. SQL and message storage were in-memory stand-ins; no real student account/data was read or written. `scripts/verify-haki-research-live.js --live` repeats this explicit paid-provider check.
- Search query, provider, caching, timeout, citation, configuration and Haki integration suites: **21 tests passed** with synthetic fixtures. The browser independently verifies search preference persistence, reconnect/draft preservation, safe result display and reduced-motion answer reveal.

## Student response latency — 22 October 2026

- Interactive DeepSeek V4 requests (Haki chat/JD comparison, interview evaluation/coaching) now request low reasoning effort, matching planning's bounded setting. The configured model/key/provider allowlist, strict schemas, rubric, output budgets, educational guards and assessment settings remain intact. Friday's implementation and configuration were not changed.
- One live synthetic evaluation with the real interview prompt/schema timed out at 40 seconds on default effort; the same synthetic input completed with valid feedback in 15.0 seconds at low effort on DeepInfra. This is one local comparison, not a latency or scoring-quality guarantee. No real student input or records were used or saved.
- Batched the two transaction-local actor settings into one bound SQL statement. Warm authenticated `SELECT 1` transactions measured 812/826/919ms before and 605/635/640ms after; initial connections measured 1841ms and 1620ms respectively. Network conditions vary. Commit/rollback isolation and existing authorization/integration checks passed.
- Targeted suites: **42 tests passed** across actor transaction isolation, student AI transport, authorization, restricted-role database, combined gateway, interview and Haki integration. Repeat explicit read-only measurements with `node --env-file-if-exists=.env scripts/benchmark-student-latency.js --live`; add `--ai` for two paid provider requests using synthetic interview text and an in-memory request ledger.

## Interview provider routing — 22 October 2026

- Reproduced Generate interview failing with OpenRouter HTTP 404: the local backend model was `openai/gpt-oss-120b:nitro`, while its allowed endpoints were `baseten/fp8,deepinfra/fp8`. Friday still used `deepseek/deepseek-v4.1-flash` with that endpoint list, and the API keys matched.
- Aligned only the ignored backend environment's model with Friday's existing model. Friday, the API key and the provider allowlist were not changed. A synthetic structured request returned HTTP 200, followed by a complete six-question generation using the real interview route's prompt/schema and an in-memory database stand-in (about 57 seconds, no student records written).
- Provider HTTP failures now distinguish incompatible model/routing, rejected credentials, insufficient credits, rate limits and timeouts. Response bodies are discarded; safe status/code/timing logs and request-ledger/concurrency cleanup remain intact.
- Student AI transport, interview integration and Haki integration: **30 passed**. Restarted only the verified backend watcher to load the environment change; backend health and the existing frontend both returned HTTP 200.

## Testing consolidation — 19 October 2026

The `testing` branch includes the student/backend platform from `0ca4e1a` and the latest placement imports, Friday conversation rename, drive fields, creator retention, attendance criteria, notices and recruitment tracking.

- Full Node 24 suite: **79 passed**, using isolated synthetic PGlite databases and restricted runtime roles. Covers fresh migrations/checksums, authorization, private student workflows, registration, assessment recovery, drive notices, hiring details and recruitment records.
- `scripts/verify-capacity.js`: passed with **50,000 synthetic student records**. This checks the dataset and bounded queries, not 50,000 simultaneous users or production throughput.
- Runtime environment validation passed without printing credentials. Real `.env`, `.env.local` and `.env.operator` files are ignored.
- File scanning found no tracked real environments, private keys or recognized provider tokens.
- npm audit at the high-severity threshold passed: **0 high/critical, 3 moderate advisories**, through `mammoth → argparse → sprintf-js` ([advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)). The server imports Mammoth's extraction API; argparse is used by its CLI. No forced downgrade was applied. Recheck for an upstream compatible fix.

Review found that enrollment self-linking accepted a typed USN from an unrelated verified email. The registration API now links only the verified identity's matched record; other submissions remain pending. `202610190006_verified_student_link.sql` applies the same ownership requirement to the legacy function. Earlier migration files and checksums are preserved. Regression checks cover unrelated-email claims, direct legacy calls, canonical university email matching and already-claimed records.

The companion web passed 77 unit checks, all five browser suites and a production build after restoring its student implementation onto the latest testing display changes. Tests used fixtures; live AI quality, deployed HTTPS/media, real PostgreSQL/pooler behavior and production concurrency need staging verification.

No shared database migration, account assignment or deployment was performed during this review. The user's migration hold remains in effect. Commit files through Git; apply database changes later through the protected operator workflow when authorized.

## Interview workspace — 21 October 2026

Selected interview integration, student integration and interview-prompt suites passed **26 tests**. New coverage verifies persisted communication preferences, invalid channel combinations, paginated session ordering without duplicates, separate-student isolation, unlinked/unauthenticated denials, input validation and statistics shape. SQL checks use isolated synthetic PGlite data.

A live frontend QA session with three hypothetical typed answers completed with three scored answers and no pending evaluations through the configured provider. No existing interview was edited, and no migration or deployment was performed. Production concurrency was not measured.

### Plan-generation timeout recovery — 21 October 2026

- Reproduced generation failure while backend readiness returned 200. Timeout classification isolated the provider deadline from backend downtime. A duplicate development watcher also prevented a second terminal backend from binding port 4000; stopped only the agent-started watcher and confirmed the user's terminal server became ready.
- Lower plan-only DeepSeek V4 reasoning effort, a 60-second provider deadline, a larger budget for more than eight questions and an 85-second frontend transport allowed the same six-question synthetic request to finish and persist. The saved plan was opened in the real authenticated browser. Model/key/provider routing and answer-evaluation settings were retained.
- Selected AI transport, interview integration and prompt suites: **23 passed**. Cover concurrency release after timeouts, failed/completed request accounting, safe diagnostic metadata, malformed/empty/truncated responses, deliberate error propagation through the API and no plan insertion on failure.

### Conversational interview — 21 October 2026

Interview guardrails, prompts, interview integration and student integration passed **42 tests**. New checks cover educational scope and directed entertainment diversions without rejecting legitimate academic project evidence. Proctored session reads return the student's own question/answer text while excluding scores, coaching, original feedback and future/private question guidance. Existing authentication, per-student ownership, order, deadlines, follow-ups, retries and report checks remain enforced.

The frontend performs local rolling transcription and five-second silence turn handling. Only final answer text is evaluated by this API; audio is not uploaded. An authenticated QA session on port 4010 saved and scored one synthetic typed answer through the existing provider, advanced its question, and ended with a report containing zero pending evaluations. No existing answer was edited and no migration was applied.
