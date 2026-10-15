# Free API and backend hosting

This alternative runs the API and gateway in ONE Render Free web service. The existing separate gateway remains supported; no data, membership, or schema migration is required.

## What changed

Set `ENABLE_PUBLIC_GATEWAY=true` on the API. This adds `/api/v1/me`, `/api/v1/overview`, `/api/v1/students`, `/api/v1/students/:id`, and `/api/v1/imports` (GET/POST) using the same handlers as `/v1`.

The public gateway requires a verified Supabase user token. Membership checks, RLS context, contact/finance restrictions, import limits, auditing, no-store headers, and rate limits still apply. The original `/v1` endpoints additionally require the service token. Gateway mode defaults to disabled. No arbitrary forwarding endpoint or automatic role assignment was added.

## Migrate the existing Render service

1. Push this repository's changes to the branch Render deploys. Review the diff first. Only source/configuration/example files should be committed; `.env`, `.local`, and certificates remain ignored.
2. Keep the current API service (`https://dsu-api-g82k.onrender.com`) on **Free**.
3. In that service's Environment, add `ENABLE_PUBLIC_GATEWAY=true`. Preserve the existing production database and Supabase settings, service token, and certificate secret file. A ready-to-import local configuration is in `.local/render-combined.env`; its real credentials must stay out of Git.
4. Deploy the new code. Build: `npm ci --omit=dev`; start: `npm start`; health check: `/health/ready`. If starting via a Blueprint instead of updating the existing service, use `render-free.yaml` as the Blueprint path. Do not create a second copy of the existing service.
5. Check `/health/ready` returns 200 and `{"status":"ready"}`. Check `/api/v1/me` without a token returns 401, not 404: this confirms the gateway is enabled and protected.
6. In the website's server environment, set `DSU_BACKEND_URL=https://dsu-api-g82k.onrender.com`. Locally this belongs in `C:\Users\shrey\.github\DSU-WEB\DSU_ERP\.env.local`. Restart/redeploy WEB and sign in. Verify overview, directory, details, and administrator imports as needed.
7. Only after the website works through the combined API service, **suspend the separate DSU-Backend Render service**. Keep its repository for rollback. Keeping both services running consumes two shares of the free-hour allowance.

No remote deployment, suspension, account creation, or keep-alive job is performed by these source changes.

## Reduce idle sleeping with a free external health check

Create a free account at https://cron-job.org/en/ and configure one HTTP job:

| Setting | Value |
| --- | --- |
| Title | DSU service health |
| URL | https://dsu-api-g82k.onrender.com/health/live |
| Method | GET |
| Schedule | Every 10 minutes |
| Authentication / custom headers / body | None |

Use the public liveness endpoint, which returns only a status and does not query student records. Never send the database password, SERVICE_TOKEN, user password, or session cookie to this scheduler. Wait for the API to finish its initial deployment and verify the health URL in a browser before testing the job. The scheduler's free request timeout is 30 seconds; an already sleeping service can take longer to start. A timeout does not prove the application has crashed; check Render logs and subsequent runs. Check job execution history if it stops; repeated failures can disable jobs automatically.

The scheduled traffic is intended to reduce idle sleeping; neither provider guarantees uninterrupted free service. No scheduler runs from the browser or your laptop.

## Free limits

Render currently supplies 750 free instance-hours per workspace per calendar month. One continuously running instance uses 720 hours in 30 days or 744 hours in 31 days. Two use 1,440/1,488 hours and cannot remain active for the entire month on that allowance. Hours already used this month by the two old services are not refunded when one is suspended. Check remaining hours in Render Billing.

These figures assume no other Free web services use the same workspace. A Next.js website hosted on Render as another Free web service also consumes hours; the existing local website does not. Bandwidth, build minutes, Supabase quotas, account restrictions, and provider availability still apply. Free is not an uptime guarantee.

## Validation

Automated tests cover combined-mode authentication, parity with private membership responses, per-user database context, anonymous/invalid-session rejection, unlinked accounts, student and staff restrictions, malformed inputs, and import rate limiting. Live Render migration and scheduler execution must be checked after deployment.

## References (checked 13 October 2026)

- https://render.com/docs/free
- https://cron-job.org/en/
- https://cron-job.org/en/faq/
