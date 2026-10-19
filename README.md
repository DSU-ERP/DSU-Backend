# DSU Backend

The Fastify API owns campus data access, placement operations and student preparation. A separate Next.js service provides the UI. Supabase PostgreSQL stores records, Supabase Auth verifies identities, Redis shares production request limits, and OpenRouter provides optional AI.

Product roles: **student** and **placement officer**. Existing admin/staff permissions remain internal operator permissions. Signup never grants officer access or links an arbitrary USN.

## Structure

- `src/app.js`: HTTP composition, request IDs, security headers, errors and limits.
- `src/server.js`: configuration, restricted database role, Redis and shutdown.
- `src/config/`: validated environment.
- `src/platform/`: HTTP errors and checksum-protected migrations.
- `src/integrations/supabase/`: bounded PostgreSQL pool and actor transactions.
- `src/modules/identity/`: JWKS JWT verification and legacy HS256 Auth verification.
- `src/modules/campus/`, `portal/`, `analytics/`, `imports/`: campus reports and imports.
- `src/modules/students/`: profiles, dashboard, documents, career, chat, interviews, assessments, practice, opportunities, calendar and officer publishing.
- `supabase/migrations/`: historical SQL and additive backend/student migrations.
- `scripts/`: protected operator tooling and environment setup.
- `test/`: unit, authorization and fresh-database integration tests.

## Local setup

Use Node 24. Run `npm ci`, `npm run env:setup`, then fill ignored `.env` runtime and `.env.operator` credentials. Setup preserves existing files and generates secrets for new files. `npm run env:check` validates without printing values. `npm run dev` starts port 4000. Legacy `.env.local` is no longer loaded by package scripts.

Runtime `DATABASE_URL` must use `dsu_api`. `DATABASE_ADMIN_URL` belongs exclusively in `.env.operator`. `DATABASE_CA_PATH` points to the real provider CA; TLS verification stays enabled. Operators use `npm run db:migrate` for reviewed migrations, separately from application startup. `npm run db:status` is read-only: it lists applied/pending migrations, whether the backend schema is ready, and row counts (never row contents). If the website shows "database update is pending", run `db:status`, then `db:migrate`, then restart the backend; the backend also logs `database_update_pending` at startup and `/health/ready` reports it.

## Contracts

All application requests use `/api/v1` with a verified user bearer token. Retained `/v1` additionally requires `X-Service-Token`. The web needs no database password or service-role key.

| Route group | Purpose |
|---|---|
| `/health/live`, `/health/ready` | Liveness and database readiness |
| `/portal/read` | Authorized campus report contract |
| `/placement/:resource`, `/placement/actions/:action` | Officer reports and mutations |
| `/placement/tools/*` | Assigned tests/results, cohort events and notices |
| `/student/me`, `/student/profile` | Official record and editable self-profile |
| `/student/dashboard`, `/student/readiness` | Preparation evidence and recommendations |
| `/student/documents`, `/student/career` | Extraction and persisted resume guidance |
| `/student/conversations/*` | Private contextual chat |
| `/student/interviews/*`, `/student/sessions/*` | Plans, sessions, reports and coaching |
| `/student/assessments/*`, `/student/attempts/*` | Generated tests, autosave and grading |
| `/student/practice/*`, `/student/assigned/unlock` | Practice and class-code access |
| `/student/opportunities/*` | Published drives, eligibility, apply/withdraw |
| `/student/calendar/*`, `/student/notifications/*` | Personal/cohort events and read receipts |

See [architecture](docs/ARCHITECTURE.md), [Render and cutover](docs/RENDER_SETUP.md), and [student behavior](docs/STUDENT-WORKSPACE.md).

## Verification

`npm test` uses isolated PostgreSQL/PGlite, synthetic identities and AI fixtures. `npm run test:capacity` loads 50,000 synthetic students without production traffic. `npm audit --audit-level=high` checks dependencies. Real PostgreSQL staging, deployed browser media and live-provider checks remain release requirements.
