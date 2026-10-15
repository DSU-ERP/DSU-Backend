# API to Backend consolidation

Date: 2026-10-15. Status: completed locally, not published, not deployed.

## Why this was smaller than it looked

The documented design was web -> backend -> API -> Postgres. In practice the
web application reads Supabase directly (`dsu_placement_read`,
`dsu_placement_mutate`, `dsu_portal_read`). `src/lib/campus-api.ts` states it:
"All portal reads go directly to Supabase. Render is used only for CSV
ingestion."

So the only live traffic through the two services was `POST /api/v1/imports`.
DSU-API's five `GET /v1/*` routes were already dead, and DSU-Backend forwarded
four routes (`/analytics`, `/batch-analytics`, `/student-categories`,
`/student-categories/:category`) that DSU-API never implemented.

The real value in DSU-API was not its HTTP layer but its 11 SQL migrations,
18 operator scripts and the CSV importer. Those are what moved.

DSU-API already supported serving `/api/v1` itself behind
`ENABLE_PUBLIC_GATEWAY`. The consolidation makes that permanent and retires the
forwarding process, so no request logic was rewritten.

## Route migration map

| Route | Was | Now | Auth | Callers |
|---|---|---|---|---|
| `GET /health/live` | both services | backend | public | Render |
| `GET /health/ready` | both services | backend, checks DB | public | Render |
| `GET /api/v1/me` | gateway -> api | backend | user token + role | web (unused, reads go to Supabase) |
| `GET /api/v1/overview` | gateway -> api | backend | admin, staff | web (unused) |
| `GET /api/v1/students` | gateway -> api | backend | admin, staff | none |
| `GET /api/v1/students/:id` | gateway -> api | backend | admin, staff, linked student | none |
| `GET /api/v1/imports` | gateway -> api | backend | admin | none |
| `POST /api/v1/imports` | gateway -> api | backend | admin, text/csv | **web, live** |
| `/v1/*` | api only | backend, retained | + `X-Service-Token` | cutover only |
| `/analytics`, `/batch-analytics`, `/student-categories*` | gateway allowlist, no upstream | removed | - | none, were 404 |

## Contract changes

One, documented and covered by a test.

`/api/v1` was opt-in behind `ENABLE_PUBLIC_GATEWAY`. It is now always
registered, because the separate gateway that owned the public surface is
retired. The flag is ignored. `/v1` is unchanged and still requires the service
token, so the previous contract keeps working during cutover and nothing has to
switch atomically.

No request or response schema changed. No web application code changed.

## Security

Unchanged. Every `/api/v1` request still verifies a Supabase user bearer token
and checks `erp.memberships` for a role, inside `withActor`, which sets the RLS
actor per connection. Both prefixes share the same handlers, so authorisation
cannot drift between them.

The service token previously guarded the hop between two processes. With one
process that hop no longer exists, so it is not a boundary on `/api/v1`. The
real boundary, user token plus role check plus RLS, is intact. No service-role
key was introduced.

## Database

No schema change. Migrations were copied, not re-created or renumbered, so the
SHA-256 checksums the runner verifies still match and nothing re-runs. The
CGPA rules remain in the database (`erp.cgpa_rules`, `erp.placement_policy`) and
are not duplicated in code: advanced >= 8.50, medium >= 6.75 and < 8.50, needs
improvement < 6.75, missing or invalid unclassified, baseline eligibility
>= 6.75 with no backlog condition.

## Rollback

The retired repository is mirrored at
`C:\Users\shrey\dsu-migration-backup-2026-10-15`.

1. `git clone <backup>/DSU-API.git DSU-API` restores all branches and history.
2. Copy `DSU-API-ignored-files/.env` and `.local/` back into the checkout.
3. Recreate the Render service from `render.yaml`, set the `sync: false` values
   and upload the CA secret file.
4. Point `DSU_BACKEND_URL` in the web service back at the old gateway.

The backup holds real credentials and is deliberately outside every Git
repository. Do not commit it or move it into a synced folder.

## Not covered by a Git backup

Deleting the GitHub repository would also remove its issues, pull requests,
releases, Actions history and run logs, branch protection and settings,
collaborators, webhooks, and any repository-level secrets. Inventory and export
anything needed from those before deletion; the mirror does not contain them.
