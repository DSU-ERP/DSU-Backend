# Render deployment and controlled cutover

Two application services: **dsu-web** from DSU-WEB and **dsu-backend** from DSU-Backend. Supabase remains database/Auth; Render Key Value supports shared limits. The old separate DSU-API is not in this topology. Definitions are prepared locally; this implementation has not deployed services or applied live migrations.

## Prepare and rehearse

Use Node 24. Backend: `npm ci`, `npm test`, `npm run test:capacity`, `npm audit --audit-level=high`. Web: `npm ci`, `npm test`, `npm run test:ui`, `npm run build`. Rehearse SQL with actual PostgreSQL/pooler on staging and verify backups.

The runner bootstraps `202610130001_erp.sql` and `202610130002_operator_role.sql` before numbered extensions for fresh databases. Existing ledger/checksums stay intact. A transaction/advisory lock protects application; changed historical checksums are rejected. Never edit/rename applied migrations. Additive `202610150001_backend_boundary.sql` and `202610150002_student_workspace.sql` add backend grants, ownership tables, publication and indexes. Existing drives default to unpublished.

Run `npm run db:migrate` from a protected operator machine with `.env.operator`. Provision dsu_api only if required: `npm run db:provision` rotates its password and updates ignored runtime configuration, so coordinate consumers. Never put admin credentials in Render/web. Do not rerun CSV imports during deployment.

## Backend

Root render.yaml defines backend plus shared Key Value. Choose a region near the database; Singapore is a configurable starting point. Starter definitions are not certified capacity sizing.

| Setting | Value |
|---|---|
| Root | repository root |
| Build | `npm ci --omit=dev` |
| Start | `npm start` |
| Health | `/health/ready` |
| Node | 24 |

Set restricted DATABASE_URL, Supabase URL/publishable key and SERVICE_TOKEN. Upload the real CA as a Render secret file; set DATABASE_CA_PATH to its /etc/secrets path. Keep TLS verification. Render supplies PORT. TRUST_PROXY=1 assumes one Render ingress hop; revisit for another topology. CORS origins are exact or empty for server-only clients. Production uses RATE_LIMIT_MODE=redis and shared Key Value URL.

Keep a stable ASSESSMENT_CODE_SECRET of at least 32 characters. Rotation invalidates class codes; Blueprint generates it once. Student AI uses backend OPENROUTER_API_KEY, STUDENT_AI_MODEL and optional provider routing. Choose a model/provider with structured output and verify in staging. Missing AI configuration returns a clear unavailable error; records, placement, calendar and objective practice continue working. Saved answers support evaluation retry.

## Web

Use DSU-WEB/render.yaml, root DSU_ERP, build `npm ci && npm run env:check && npm run build`, start `npm start -- --hostname 0.0.0.0 --port $PORT`, health /health/live. /health/ready separately probes backend.

Set public Supabase URL/publishable key at build and real HTTPS DSU_BACKEND_URL. Web has no DB or service-role secrets. Existing officer Friday integrations use optional web-side OpenRouter/search/mail; student AI uses backend settings.

Blueprint generates persistent base64 32-byte NEXT_SERVER_ACTIONS_ENCRYPTION_KEY. Reuse across builds/replicas of one service pool. RENDER_GIT_COMMIT supplies deployment ID. Public env changes require rebuild. Configure Supabase site/confirmation URLs for the real hostname and verify signup/password sign-in.

## Access and publication

`npm run access:grant -- <auth-user-uuid> student <USN>` links an existing Auth user to an official record. Use scripts/grant-placement-officer.js for officers. Signup metadata never authorizes roles. Officers publish intended drives, create tests under Student tests & campus, and share class codes directly. Public notices omit codes.

## Required legacy-RPC cutover

Additive migrations retain authenticated RPC grants during rolling deploy. After **both** new apps work, run `npm run access:lock-rpc` to preview, then `npm run access:lock-rpc -- --apply` to revoke authenticated execution of all six legacy PostgREST RPCs (campus, batch, placement read/write, import history and Friday rename). Until then, old RPC clients can bypass backend request limits, although SQL authorization still applies. Backend grants remain. Recheck both roles. Rolling back to an old direct-RPC web requires reviewed grants rollback.

The 18 October integration also requires the fetched placement-import and Friday-rename migrations, followed by `202610180001_friday_backend.sql` and `202610180002_assessment_grading_progress.sql`. The standard migration runner applies these in order. Written assessment grading now persists at most five answers per request; resuming evaluation retains completed batches.

## Release evidence

Confirm readiness, separate-student isolation, officer access, profile save, published-drive registration, code/batch/window checks, original timer after reload, evaluation recovery and real media permissions. Fixtures do not prove live AI quality/browser speech. Monitor request IDs, errors, DB/Redis limits and provider costs before increasing traffic.

References: [Render Blueprint](https://render.com/docs/blueprint-spec), [deploys](https://render.com/docs/deploys), [Next action keys](https://nextjs.org/docs/messages/failed-to-find-server-action).
