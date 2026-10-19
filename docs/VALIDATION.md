# Testing consolidation — 19 October 2026

The `testing` branch includes the student/backend platform from `0ca4e1a` and the latest placement imports, Friday conversation rename, drive fields, creator retention, attendance criteria, notices and recruitment tracking.

- Full Node 24 suite: **79 passed**, using isolated synthetic PGlite databases and restricted runtime roles. Covers fresh migrations/checksums, authorization, private student workflows, registration, assessment recovery, drive notices, hiring details and recruitment records.
- `scripts/verify-capacity.js`: passed with **50,000 synthetic student records**. This checks the dataset and bounded queries, not 50,000 simultaneous users or production throughput.
- Runtime environment validation passed without printing credentials. Real `.env`, `.env.local` and `.env.operator` files are ignored.
- File scanning found no tracked real environments, private keys or recognized provider tokens.
- npm audit at the high-severity threshold passed: **0 high/critical, 3 moderate advisories**, through `mammoth → argparse → sprintf-js` ([advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)). The server imports Mammoth's extraction API; argparse is used by its CLI. No forced downgrade was applied. Recheck for an upstream compatible fix.

Review found that enrollment self-linking accepted a typed USN from an unrelated verified email. The registration API now links only the verified identity's matched record; other submissions remain pending. `202610190006_verified_student_link.sql` applies the same ownership requirement to the legacy function. Earlier migration files and checksums are preserved. Regression checks cover unrelated-email claims, direct legacy calls, canonical university email matching and already-claimed records.

The companion web passed 77 unit checks, all five browser suites and a production build after restoring its student implementation onto the latest testing display changes. Tests used fixtures; live AI quality, deployed HTTPS/media, real PostgreSQL/pooler behavior and production concurrency need staging verification.

No shared database migration, account assignment or deployment was performed during this review. The user's migration hold remains in effect. Commit files through Git; apply database changes later through the protected operator workflow when authorized.
