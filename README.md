# DSU Backend

Consolidated backend for the DSU ERP: HTTP routes, business logic, database
access, CSV import, analytics, schema migrations and operator tooling in one
service. It replaces the previous pair of a `dsu-backend` forwarding gateway
and a separate `dsu-api` service.

## Structure

    src/
      app.js                        Fastify app, routes, auth, error handling
      server.js                     process entry point
      integrations/supabase/db.js   pool, TLS, withActor RLS wrapper
      modules/
        imports/{csv,importer}.js   CSV validation and transactional import
        analytics/                  category rules, placement policy, analytics
    supabase/migrations/            SQL source of truth (11 files)
    scripts/                        migrate, provision, import, grant, verify
    test/                           unit and authorization tests

## HTTP contract

| Route | Prefix | Access |
|---|---|---|
| `GET /health/live` | - | public |
| `GET /health/ready` | - | public, checks the database |
| `GET /me` | `/api/v1`, `/v1` | linked account |
| `GET /overview` | `/api/v1`, `/v1` | admin, staff |
| `GET /students` | `/api/v1`, `/v1` | admin, staff |
| `GET /students/:id` | `/api/v1`, `/v1` | admin, staff, or the linked student |
| `GET /imports` | `/api/v1`, `/v1` | admin |
| `POST /imports?batch=YYYY` | `/api/v1`, `/v1` | admin, `text/csv` |

`/api/v1` is the public contract the web application calls through
`DSU_BACKEND_URL`. It requires a Supabase-verified user bearer token and an
`erp.memberships` role check on every request.

`/v1` additionally requires `X-Service-Token`. It is retained unchanged so the
previous gateway contract keeps working during cutover, and can be removed once
nothing calls it.

Both prefixes run the same handlers, so authorisation cannot drift between them.

## Local development

Requires Node 22 or newer. Copy `.env.example` to `.env` and fill it in.

    npm ci
    npm run db:check
    npm run dev
    npm test

## Operator commands

    npm run db:migrate      apply pending migrations under an advisory lock
    npm run db:provision    create or rotate the restricted runtime role
    npm run csv:import      import a batch CSV from the command line
    npm run access:grant    grant a role to a Supabase Auth user
    npm run verify:database verify against synthetic rows in a rolled-back txn

Migrations verify SHA-256 checksums of already-applied files and never reset a
schema. `DATABASE_ADMIN_URL` is required for migration and provisioning and must
stay on an authorised operator machine; it is never set in Render.

## Deployment

Render blueprint in `render.yaml`. Build `npm ci --omit=dev`, start `npm start`,
readiness `/health/ready`. The process binds `0.0.0.0:$PORT`. Upload the
Supabase CA as a secret file and point `DATABASE_CA_PATH` at it. Set every
`sync: false` value in the dashboard. Never disable TLS verification.

Free-tier instances hibernate, so the first request after idle is slow. That is
a hosting characteristic and is not changed by this consolidation.
