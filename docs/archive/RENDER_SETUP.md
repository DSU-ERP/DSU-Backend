# Host DSU API and Backend on Render

Prepared 13 October 2026. This guide deploys two Node web services. Supabase already contains the database and student data; do not create a new Render database or re-import CSVs during deployment.

## 1. Push source code

Both local service repositories currently have no commits. Run these commands in PowerShell after reviewing the staged filenames. The ignore rules exclude `.env`, `.local`, dependencies, and API certificates/CSV data. Do not force-add ignored files.

```powershell
cd "C:\Users\shrey\.github\DSU-API"
git add .
git diff --cached --name-only
git commit -m "Add DSU API and Render configuration"
git push -u origin main

cd "C:\Users\shrey\.github\DSU-Backend"
git add .
git diff --cached --name-only
git commit -m "Add DSU backend gateway and Render configuration"
git push -u origin main
```

The remotes are `DSU-ERP/DSU-API` and `DSU-ERP/DSU-Backend`. GitHub access is required. If a push is rejected because the remote has commits, reconcile them before retrying; do not force-push.

## 2. Deploy API first

In https://dashboard.render.com select **New → Web Service**, connect GitHub, and select `DSU-ERP/DSU-API`. Grant Render access to this organization/repository if needed.

| Setting | Value |
| --- | --- |
| Name | dsu-api (or another available name) |
| Branch | main |
| Language / runtime | Node |
| Root directory | Leave empty |
| Build command | npm ci --omit=dev |
| Start command | npm start |
| Health check path | /health/ready |

Use an always-on paid instance for production. Choose the same region for API and Backend, preferably close to the Supabase database (the supplied pooler is in Seoul). Do not assume a particular Render region is available; select from the dashboard.

Under Environment, use **Add from .env** and paste the contents of:

`C:\Users\shrey\.github\DSU-API\.local\render-api.env`

This private file contains the actual runtime credentials and production settings:

| Variable | Purpose |
| --- | --- |
| NODE_ENV | production |
| NODE_VERSION | 24 |
| TRUST_PROXY | 1 |
| DATABASE_URL | Existing restricted dsu_api session-pooler connection, with password |
| DATABASE_SSL | true |
| DATABASE_CA_PATH | /etc/secrets/prod-ca-2021.crt |
| SUPABASE_URL | Existing project URL |
| SUPABASE_PUBLISHABLE_KEY | Existing publishable key |
| SERVICE_TOKEN | Existing shared API/backend secret |
| CORS_ORIGINS | Empty; the API receives server-to-server calls |

If Render omits the empty CORS_ORIGINS entry, that is fine: the API defaults to an empty browser-origin allowlist. Render supplies PORT automatically. DATABASE_ADMIN_URL is intentionally absent: deployment uses the restricted database account, and migrations/provisioning have already run.

On the API service's **Environment → Secret Files → Add Secret File**, enter:

- Filename: `prod-ca-2021.crt`
- Contents: the complete text of `C:\Users\shrey\Downloads\prod-ca-2021.crt`, including its BEGIN/END CERTIFICATE lines.

Save and deploy after both variables and certificate are configured. If service creation starts an earlier deployment, let it redeploy after adding the certificate. The file is mounted at `/etc/secrets/prod-ca-2021.crt`; do not use the Windows path in Render.

Copy the actual HTTPS service URL shown by Render. Verify `<API_URL>/health/ready` returns `{"status":"ready"}`. The root `/` is not a health endpoint and can return 404.

## 3. Deploy Backend

Create another **Web Service**, connected to `DSU-ERP/DSU-Backend`. Use the same settings above, with name `dsu-backend`. Root directory remains empty.

Open:

`C:\Users\shrey\.github\DSU-Backend\.local\render-backend.env`

Replace only the placeholder DSU_API_URL with the actual API HTTPS URL. It must be an origin, such as `https://your-api-name.onrender.com`, without `/v1` or `/health/ready`.

Use **Add from .env** to paste that file into Backend's environment:

| Variable | Purpose |
| --- | --- |
| NODE_ENV | production |
| NODE_VERSION | 24 |
| TRUST_PROXY | 1 |
| DSU_API_URL | Actual API HTTPS origin |
| SERVICE_TOKEN | Same value as API, already included in the exported file |
| CORS_ORIGINS | http://localhost:3000 for the current local website |

When the website is hosted, replace/add its exact HTTPS origin in CORS_ORIGINS (comma-separated, no paths or spaces). Next.js currently calls the gateway on the server, so this setting is not authentication. Backend does not need database credentials or the CA certificate.

Deploy and verify `<BACKEND_URL>/health/ready` returns `{"status":"ready"}`. An unauthenticated call to `/api/v1/students` should return 401.

## 4. Connect the website

In `C:\Users\shrey\.github\DSU-WEB\DSU_ERP\.env.local`, replace the existing DSU_BACKEND_URL line with:

```dotenv
DSU_BACKEND_URL=https://YOUR-ACTUAL-BACKEND.onrender.com
```

Keep the existing Supabase URL/key. Restart Next.js. Only the website needs to run locally once the two Render services are healthy. Sign in at http://localhost:3000/login using the administrator account's email/password. If WEB is hosted later, set DSU_BACKEND_URL in that host's server environment and redeploy. Never expose SERVICE_TOKEN or DATABASE_URL with NEXT_PUBLIC_ variables.

## Troubleshooting

- Missing certificate / ENOENT: add the secret file with the exact filename and Linux path above.
- Startup database error: use the exported restricted DATABASE_URL unchanged; the owner/postgres connection is deliberately rejected by the API.
- Backend startup failure: check HTTPS DSU_API_URL and SERVICE_TOKEN. Replace the placeholder before deployment.
- Backend readiness 503: check API readiness and the API URL first.
- Sign-in succeeds but portal cannot load: verify DSU_BACKEND_URL, both service health endpoints, and matching SERVICE_TOKEN values.
- Access pending: a Supabase Auth account also needs an ERP membership. The administrator UUID supplied in this conversation has already been assigned.
- Free services sleep after 15 minutes of inactivity and can take about a minute to wake. The gateway's 12-second request timeout can expire during API cold starts. Use always-on instances for reliable production access.

The generated credential files are ignored by Git. Import them through Render's Environment UI; do not commit them. These instructions do not mean deployment has been performed or billed.

## Official references

- https://render.com/docs/web-services
- https://render.com/docs/configure-environment-variables
- https://render.com/docs/health-checks
- https://render.com/docs/free
