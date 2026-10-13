# DSU Backend

Independent application gateway between DSU-WEB and DSU-API. This repository was empty at initial inspection. It owns the public service boundary, exact-origin CORS, request limits, upstream timeouts, safe errors, and the server-to-server credential. The API owns database access and final user/role authorization. No database credentials belong here.

```sh
npm ci
# Copy .env.example to .env and fill the values if not already configured.
npm run dev
npm test
```

Default port: 4000. WEB's `DSU_BACKEND_URL` points here. `DSU_API_URL` points to the API origin (4001 locally, HTTPS Render URL in production). `SERVICE_TOKEN` must match the API. Only explicit `/api/v1/me`, `/overview`, `/students`, `/students/:id`, and `/imports` routes are forwarded; client-supplied service secrets and arbitrary upstream URLs are ignored. Supabase user access tokens pass through to API verification, never logged. The browser reaches this service through the separately hosted Next.js server, keeping bearer credentials in HttpOnly cookies.

`GET /health/live` is process liveness. `GET /health/ready` checks upstream readiness with a 5-second timeout. GET requests time out at 12 seconds, imports at 40 seconds. Requests are capped at 10 MB and 100 per IP/minute. There are no automatic POST retries. Configure a shared limiter before multi-instance scaling. `TRUST_PROXY=1` is only appropriate behind exactly one trusted proxy; do not use it for direct exposure.

Production: `npm ci --omit=dev`, then `npm start`; listen on Render/host-provided `PORT` and `0.0.0.0`. Optional Dockerfile and Render blueprint included. Supply HTTPS `DSU_API_URL`, matching random `SERVICE_TOKEN`, and exact WEB origins in `CORS_ORIGINS`. No wildcard origin or privileged Supabase key. See `../DSU-WEB/DSU_ERP/INTEGRATION.md` for system-wide setup and results.
