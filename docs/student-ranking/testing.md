# Students Ranking: testing

All tests use synthetic fixtures in isolated environments: the in-memory PGlite database for the backend and a local fixture page for the browser checks. Nothing is inserted into ERP-DSU or any Supabase project, and no test contacts GitHub or LeetCode.

## Backend

```powershell
cd C:\Users\shrey\.github\DSU-Backend
node --no-wasm-tier-up --test --test-concurrency=1 test/ranking-engine.test.js test/ranking-sources.test.js test/ranking.integration.test.js
```

| File | Covers |
| --- | --- |
| `test/ranking-engine.test.js` | CGPA scale, missing and invalid CGPA, ties; easy-heavy vs medium/hard DSA, easy cap, bounds; missing profile, zero activity, missing contest, outage before and after data, stale, disputed, not shared, incomplete counts; few strong vs many trivial repositories, forks, foreign pinned repositories, breadth cap; rubric parts, missing tests and docs, unobservable points, stars ignored, unreadable repositories; revoked tokens; project classification; weights, no redistribution, coverage, reproducibility, model versions, consent and sharing; department fairness; topic thresholds, overlapping tags, no core-subject scores |
| `test/ranking-sources.test.js` | LeetCode batching (one request for concurrent lookups, per-user not found, batch cap, case-insensitive duplicates, request spacing), shared pause on 429 and 403, outages, invalid usernames; contest metrics omitted; profile name not stored; name match cases; GitHub root evidence; commit share |
| `test/ranking.integration.test.js` | Seeded model and taxonomy equal the code; worker-only functions refuse API transactions; full pass and window; university, department and batch ranks with ties; missing CGPA; search and pagination keep ranks; DSA, GitHub, developer and topic views; real overview counts; student explanation and positions; incremental recalculation and history; officer-only access; filter validation; no secret fields |
| `test/intelligence-student.integration.test.js` | Updated: LeetCode links queue a sync, the worker writes verified LeetCode metrics through a fake provider, scheduled sync includes LeetCode |

Results on 27 October 2026: full backend suite 266 of 267. The one failure, "information events never count as integrity strikes" in `interview-guardrails.test.js`, predates this work. `test/mcp-web-search.test.js` is excluded because it hangs on this machine.

## Web

```powershell
cd C:\Users\shrey\.github\DSU-WEB\DSU_ERP
npx tsc --noEmit
npm test
npm run test:ranking-ui
```

`scripts/verify-ranking-ui.cjs` renders the real components and sidebar at 1600, 1440, 1280, 1024, 768 and 390 pixels in light and dark themes. It checks: no page overflow and no em dashes; header and provisional notice; counts; sidebar order, active state on the module and its detail pages, collapsed icon with tooltip, mobile menu; dense ranks, ties and pagination; per-view columns and unranked reasons; only assessable topics offered; filters, search and reset; drill-down explanation, rubric with unobservable points, topic honesty; comparison; no browser errors. Screenshots go to `.qa/ranking-ui`.

`scripts/verify-overview-ui.cjs` was updated for the new sidebar link (15 routes, 16 with the testing module).

## Not yet tested

- Against real GitHub and LeetCode responses at scale (requires the GitHub App and a staging database).
- Query performance on a production-sized cohort. The ranking views use window functions over the filtered cohort; expected to be well within the 15 s statement timeout for thousands of students, but not measured.
- Real officer sign-in against the live API.
