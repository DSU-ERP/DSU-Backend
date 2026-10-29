# Student Skills Intelligence: plan and contract

Status: implementation plan and API contract (2026-10-22). Local only. No migration has been
applied to the shared Supabase project and no Render service was changed.

Central rule: one student identity (`erp.students.id`), one canonical profile service in the
backend, several authorized views (Student Dashboard, Student Categories, Student Analytics,
Placement Officer profile, F.R.I.D.A.Y.).

## 1. Audit summary (what already exists)

- Auth: Supabase email and password (web Server Action). The backend verifies the JWT and runs
  every query in `withActor()` as the restricted `dsu_api` role. Roles come only from
  `erp.memberships` and `placement.officers`. `GET /session` returns `student`,
  `placement_officer` or null. There is no Admin portal in the web app (admin and staff exist only
  in the database), so Sign In offers Student and Placement Officer.
- Verified linking already exists: `student.registration_context()` and `link_registration()` link
  a student only through a confirmed email that matches `erp.contacts` or `<usn>@dsu.edu.in`.
  A typed USN never links (hardened in 202610190006).
- Registration onboarding (`/onboarding`, `student.registration_drafts`) links the record. It has
  no version, no platforms and no visibility settings.
- Official academics: `erp.students`, `erp.academics` (CGPA numeric). Category rules live in
  `erp.cgpa_category()` and `categoryRules.js`: Advanced >= 8.50, Medium 6.75 to < 8.50,
  Needs Improvement < 6.75, missing or invalid CGPA unclassified. Eligibility is
  `erp.placement_eligible()` (valid CGPA >= 6.75).
- Officer reads: `public.dsu_placement_read(resource, q)` owned by `dsu_placement`, guarded by
  `placement.assert_officer()`. All existing rankings use `rank()` (1,1,3).
- There are no platform integrations, encryption utilities, job system or provenance model.
- There are no charts on Placement Overview; existing charts are hand-built SVG with hidden tables.
- F.R.I.D.A.Y. runs in the web app and calls backend reads with the officer's token.

## 2. Decisions

1. New tables are keyed by `student_id -> erp.students(id) ON DELETE CASCADE`. Students write
   through `erp.actor_student()`. Officers read only through SECURITY DEFINER functions owned by
   `dsu_placement` that call `placement.assert_officer()`.
2. Ranking: `DENSE_RANK() OVER (ORDER BY cgpa DESC)` over classified students. The scope is
   always the passing-out batch. `batch_rank` covers the whole batch; `category_rank` covers the
   student's category within the batch. Department, search, eligibility and skill filters only hide
   rows and never change a rank. Display ties are ordered by USN (C collation), then id. One SQL
   function (`erp.cgpa_ranks`) is used by the dashboard, the directory, exports and F.R.I.D.A.Y.
   The legacy `college_rank` (rank()) stays only in the legacy resources.
3. Skills onboarding is separate from registration and versioned (current version 1). It is
   required for linked students before the dashboard. It is enforced by `/session`, the student
   layout and `GET /student/dashboard`.
4. GitHub: GitHub App user authorization (web flow with PKCE and state) through the Octokit SDK.
   The fallback is a fine-grained PAT (`github_pat_` only). Tokens are encrypted with AES-256-GCM
   using keys held only in backend env. Only public data is read; private repositories are never
   requested.
5. Hugging Face: official public Hub API (counts from `/api/users/{u}/overview`).
   LeetCode: public profile data (solved counts, topic tags, contest summary) read by the sync
   worker since 27 October 2026; see docs/student-ranking/evidence-sources.md. HackerRank,
   LinkedIn and Kaggle: no supported public profile API, so validated profile links plus clearly
   labelled student-submitted figures. These are never fetched or scraped.
6. Background sync: Postgres job table, `FOR UPDATE SKIP LOCKED` leasing, an in-process poller
   started by `server.js` (env `SYNC_WORKER`). External calls happen outside transactions.
7. Provenance values: `institution_verified`, `platform_verified`, `student_submitted`,
   `ai_generated`, `unavailable`.
8. No numeric readiness score. Readiness is a list of evidence statements and missing items.
9. AI summaries are generated in the backend with `generate()` (strict schema). Every claim must
   cite evidence ids from a server-built list; uncited claims are dropped. Inputs never include
   tokens, contact or family data.

## 3. Database (migration `202610220001_student_intelligence.sql`)

All tables: RLS enabled, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, explicit grants to
`dsu_api` (and `dsu_placement` where officer functions read them). Enumerations are text + CHECK.

- `student.skill_profiles(student_id PK, onboarding_version int default 0,
  onboarding_completed_at, identity_confirmed_at, visibility_saved_at, consent_version int, consented_at,
  visibility jsonb default {"platforms":true,"projects":true,"activity":true,"summary":true},
  revision int default 0, created_at, updated_at)`
- `student.platform_accounts(id uuid PK, student_id, platform in
  (github,leetcode,hackerrank,linkedin,huggingface,kaggle), state in
  (linked,declared_none,disconnected), handle, profile_url, auth_method in
  (github_app,github_pat,public_api,link_only,none), ownership in
  (platform_verified,student_submitted,unavailable), external_id, submitted jsonb default {},
  visible bool default true, sync_status in
  (not_applicable,pending,running,completed,partial,failed,unavailable), sync_error,
  last_synced_at, last_attempt_at, manual_refresh_at, revision, created_at, updated_at,
  UNIQUE(student_id,platform))` plus a partial unique index `(platform, external_id)` where
  `external_id IS NOT NULL AND state='linked'`.
- `student.platform_credentials(account_id PK -> platform_accounts ON DELETE CASCADE,
  kind in (github_user_token,github_pat), key_id, access_cipher, refresh_cipher,
  access_expires_at, refresh_expires_at, created_at, updated_at)`. SELECT is allowed only when
  `current_setting('app.credential_access', true) = 'on'`, and then only for the owning student or
  for the worker. No route ever returns these columns.
- `student.platform_snapshots(id uuid PK, account_id, student_id, platform, status, method,
  payload jsonb, collected_at)`. The worker keeps the latest 5 per account.
- `student.platform_metrics(account_id, metric, student_id, platform, value jsonb, verification,
  method, snapshot_id, collected_at, note, PK(account_id, metric))`.
- `student.github_repositories(account_id, repo_id bigint, student_id, full_name, name, url,
  description, primary_language, languages jsonb, topics jsonb, stars, forks, is_fork,
  is_archived, has_readme, readme_bytes, license, homepage, pushed_at, repo_updated_at,
  owner_login, pinned bool, pin_order, recommendation_score int, recommendation_reasons jsonb,
  additions_52w int null, snapshot_id, PK(account_id, repo_id))`.
- `student.featured_projects(student_id, position 1..3, account_id, repo_id, selected_at,
  PK(student_id, position), UNIQUE(student_id, repo_id), FK(account_id, repo_id) ON DELETE CASCADE)`.
- `student.profile_summaries(id uuid PK, student_id, model, content jsonb, evidence jsonb,
  input_hash, sources jsonb default [], hidden bool default false, reviewed_at, created_at)`.
  `sources` lists the evidence groups used (`platforms:<platform>`, `projects`, `activity`).
- `student.profile_summary_attempts(id bigint identity PK, student_id, created_at)`: one row per
  generation attempt, written before the model is called; the 3 per hour limit counts these.
- `student.sync_jobs(id bigint identity PK, account_id, student_id, platform, reason in
  (connect,manual,scheduled,retry), status in
  (pending,running,completed,partial,failed,unavailable,cancelled), attempts, max_attempts default 5,
  run_after, leased_until, last_error, created_at, updated_at)` plus a unique index on
  `(account_id) WHERE status IN ('pending','running')`.
- `student.oauth_states(state_hash PK, user_id, student_id, verifier_cipher, created_at,
  expires_at, consumed_at)`.

Policies: owner `student_id = erp.actor_student()`. The worker is allowed when
`student.sync_worker()` is true (`current_setting('app.sync_worker', true) = 'on'`). Officers use
the SECURITY DEFINER functions below. dsu_placement gets SELECT with
`USING (placement.authorized())` on the skill tables (never on credentials or oauth_states).

Functions:

- `student.onboarding_current_version() -> int` (returns 1).
- `erp.cgpa_ranks(batch text) -> TABLE(student_id, batch, cgpa, category, batch_rank, category_rank,
  batch_size, category_size)`. NULL batch means all batches, still partitioned by batch.
- `student.my_ranking() -> jsonb`: the actor student's own ranks and cohort sizes (definer).
- `placement.ranked_students(q jsonb) -> jsonb`: officer directory (section 5).
- `placement.overview_charts(q jsonb) -> jsonb`: KPIs and chart series (section 6).
- `placement.student_core(id uuid) -> jsonb`: identity, academics, category, eligibility, ranks,
  placement status summary. No contact or family fields.
- `placement.skill_profile(id uuid, purpose text) -> jsonb`: platform accounts, metrics, featured
  projects, top repositories, latest visible summary, filtered by the student's visibility, with
  provenance on every value. purpose in (`officer`, `ai`). Until the student has consented
  (`consent_version >= 1`, set at onboarding completion) it returns only onboarding status and
  per-platform state. The summary is withheld (`summary: null, summaryWithheld: true`) when any
  of its `sources` is no longer shared (visibility toggle, hidden or disconnected account).
- `placement.skill_students(q jsonb) -> jsonb`: students by skill-profile status (F.R.I.D.A.Y.).
  `linkedPlatforms` is empty until consent and never lists hidden accounts.
- `student.skill_status(student uuid)`: `complete` only when the onboarding version is current and
  every required platform is still linked or declared as not used; otherwise `incomplete`
  (`not_started` without a profile row). A later disconnect does not force re-onboarding.
- `placement.lookup_students(q jsonb) -> jsonb`: exact USN (case-insensitive) or name substring,
  at most 10 matches, each with `id, usn, name, department, batch, profile_url`.

## 4. Student API (backend `/api/v1`, `{data}` envelope, linked student required)

- `GET /student/skills/profile` returns the canonical self view:
  `{academic, ranking, onboarding, visibility, accounts[], github{repositories[], featured[],
  pinned[]}, summary, readiness, revision}`.
  - `academic` = `{name, usn, department, departmentName, program, batch, semester, cgpa,
    category, categoryLabel, eligible, provenance:'institution_verified'}`, read from erp only.
    It never reads `student.profiles.details`.
  - `ranking` = `{batchRank, categoryRank, batchSize, categorySize, scope:'batch'}`.
  - `onboarding` = `{version, currentVersion, complete, completedAt, identityConfirmedAt,
    consentedAt, sections:{identity, github, leetcode, hackerrank, linkedin, huggingface, kaggle,
    visibility}, missing:[...]}`. Required sections: identity, github, leetcode, hackerrank,
    linkedin, visibility. Hugging Face and Kaggle are optional.
  - Account = `{platform, state, handle, profileUrl, authMethod, ownership, visible, syncStatus,
    syncError, lastSyncedAt, submitted, metrics:[{metric, label, value, verification, method,
    collectedAt, note}]}`.
- `POST /student/skills/onboarding`, body is one of:
  - `{action:'confirm_identity'}`
  - `{action:'visibility', visibility:{platforms,projects,activity,summary}, revision}`
  - `{action:'complete', consent:true, revision}`. Returns 409 `ONBOARDING_INCOMPLETE` with
    `missing`, or 409 `PROFILE_CHANGED`.
- `POST /student/skills/platforms/:platform`, body is one of:
  - `{action:'link', value, submitted?, visible?}`. For GitHub this returns 400
    `GITHUB_AUTH_REQUIRED`.
  - `{action:'declare_none'}`
  - `{action:'disconnect'}`
  - `{action:'visibility', visible}`
- `POST /student/skills/platforms/github/authorize` returns `{url}`, or 503
  `GITHUB_APP_NOT_CONFIGURED`.
- `POST /student/skills/platforms/github/callback {code, state}` returns the account.
- `POST /student/skills/platforms/github/token {token}`: fine-grained PAT; returns the account.
- `POST /student/skills/platforms/:platform/refresh`: at most once per 10 minutes per account
  (429 `REFRESH_LIMIT`).
- `POST /student/skills/featured {repoIds:[<=3]}`: student-selected featured projects.
- `POST /student/skills/summary`, body is one of:
  - `{action:'generate'}`
  - `{action:'review', id}`
  - `{action:'hide', id, hidden}`
- `GET /session` adds `onboardingRequired` for students. Home is `/student/onboarding` while it
  is required.
- `GET /student/dashboard` and `GET /student/readiness` (same payload) return 403
  `ONBOARDING_REQUIRED` while it is required.

Student-submitted fields (validated, stored in `submitted`, always labelled `student_submitted`):

- LeetCode: `solved`, `easy`, `medium`, `hard`, `contestRating`, `contestsAttended`.
- HackerRank: `badges[{name, stars}]` (up to 20), `certifications[{name, url}]`. Certificate URLs
  must match `https://www.hackerrank.com/certificates/<id>`.
- Kaggle: `achievements[{title}]` (up to 10).
- LinkedIn: link only.

## 5. Officer API

- `GET /placement/categories?batch&department` returns the three category cards:
  `{id, name, range, total, cohortPercentage, averageCgpa, eligible, eligibilityPercentage}`,
  plus `unclassified`, `total`, `batch`, `batches`, `departments`.
- `GET /placement/categories/:category/students?batch&department&search&eligibility&skill&sort&page&limit`
  returns the ranked directory:
  - `{rows[{id, usn, name, department, batch, semester, cgpa, category, eligible, categoryRank,
    batchRank, skillStatus, profileUrl}], pagination, scope}`.
  - The default sort is rank. `export=true` returns up to 20,000 rows, is rate-limited to
    5 per minute and is audited.
- `GET /placement/overview/charts?batch&department` (section 6).
- `GET /placement/students/:id/profile?purpose=officer|ai` returns
  `{core, skills, summary, readiness, provenance}`. `purpose=ai` never includes contact or family
  data.
- `GET /placement/students/lookup?usn=|name=` is used by F.R.I.D.A.Y.
- `GET /placement/skills/students?batch&department&status&page&limit` is used by F.R.I.D.A.Y.

## 6. Placement Overview definitions

All KPIs and charts share one cohort filter (batch, department).

| Measure | Definition |
|---|---|
| Total students | Students in the cohort. |
| Placement eligible | Valid CGPA >= 6.75. |
| Students placed | Distinct students holding an active (offered or accepted) offer. |
| Placement rate | Placed / total. Also shown: placed eligible / eligible. |
| Participating companies | Companies with at least one drive for the batch. |
| Active drives | Drives with status upcoming or ongoing. |
| Accepted offers | Offers with status accepted. |
| Average CGPA | Mean of valid CGPAs, 2 decimals. |

Charts:

- **Line:** monthly (Asia/Kolkata), at most the last 24 months that have data. Series:
  - students first placed, by the month their first active offer was recorded;
  - offers recorded;
  - drives completed (status completed, by `drive_date`).
  The dates are when offers were recorded in the ERP, because no real offer date exists. The UI
  says so. With no events, the series is empty and a no-data state is shown.
- **Donut:** placed / eligible not placed / not eligible not placed / CGPA unknown not placed.
  The four segments add up to the total.
- **Bar:** per department: total, eligible, placed.

## 7. Background sync

The worker loop:

- Every 5 s it claims up to `SYNC_WORKER_CONCURRENCY` (default 2) due jobs with SKIP LOCKED and a
  2-minute lease.
- It calls the provider outside any transaction and writes results in a second transaction.
- Retries use backoff `2^attempts` minutes, up to 5 attempts, and respect provider reset times.
- Every 10 minutes it enqueues linked accounts with `last_synced_at` older than
  `SYNC_INTERVAL_HOURS` (default 24).

A failed sync keeps the previous metrics and never changes onboarding state.

## 8. Environment (backend only)

- `INTEGRATION_ENCRYPTION_KEYS` (`kid:base64-32-bytes`, comma separated)
- `INTEGRATION_ENCRYPTION_KEY_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_SLUG` (optional)
- `GITHUB_OAUTH_REDIRECT_URL`, for example `http://localhost:3000/student/connections/github/callback`
- `SYNC_WORKER` (on|off)
- `SYNC_WORKER_CONCURRENCY`
- `SYNC_INTERVAL_HOURS`

## 9. Development test account

`scripts/provision-dev-student.js` (operator, dry run unless `--apply`). It refuses to run unless
every check below passes:

- `DSU_ENVIRONMENT=development`;
- the target Supabase project ref is not protected (`idioblehzhaibtgotfjk` is always protected)
  and differs from `SUPABASE_URL`;
- `DEV_DATABASE_ADMIN_URL`, parsed and decoded the way `pg` parses it (including `?host=` and
  `?user=`), names no protected ref in its user, host or database, and its host is exactly
  `db.<dev-ref>.supabase.co` or a Supabase pooler with user exactly `postgres.<dev-ref>`
  (a local database only with `DEV_ALLOW_LOCAL_DB=1`);
- the target database has the marker `erp.environment_marker` = `isolated-development`;
- the target database has no `erp.students` row outside the synthetic `DEV` prefix.

If all pass, it creates `student@gmail.com` through the Supabase Admin API and a synthetic record
`DEVSTUDENT0001` with a membership, in one transaction: the Auth user is created only after the
student rows insert, and is deleted again if the transaction fails. It never grants officer or admin roles. This machine has no
isolated project, so the account was not provisioned.

## 10. Implementation plan and progress (revised 2026-10-22, evening)

### Done

1. **Audit:** 18 read-only agents covered both repos. Findings are summarised in section 1.
2. **Plan and contract:** this document; `src/modules/intelligence/constants.js` (platforms,
   provenance, the onboarding rule); route wiring in `app.js`.
3. **Database layer:** `supabase/migrations/202610220001_student_intelligence.sql`, readiness
   entries, and `test/intelligence-schema.integration.test.js`.
   - The new test file passes 10/10.
   - The full suite passes 162/163. The one failure is pre-existing and unrelated: the
     `interview-guardrails` test "information events never count as integrity strikes" also fails
     on the untouched baseline.
   - Known local issue: `test/mcp-web-search.test.js` ("real child processes") hangs on this
     Windows machine, which stops `npm test` from finishing. Run the suite with that file
     excluded until it is fixed.
   - The migration has NOT been applied to the shared database.

### Remaining work, in order

Each track below owns its files. Tracks in the same step run in parallel and must not edit each
other's files.

**Step 4: Backend integrations.** Owns:

- `src/platform/crypto/secrets.js`
- `src/modules/intelligence/{platforms,github,huggingface,sync,worker,student-routes}.js`
- `src/config/env.js`, `src/server.js` (worker start and stop)
- `src/modules/identity/routes.js` (`onboardingRequired` in `/session`)
- the dashboard onboarding gate in `src/modules/students/dashboard.js`
- `scripts/provision-dev-student.js`, `package.json` (`octokit@5.0.5`), `.env.example`
- tests under `test/intelligence-*.test.js` (except the schema test)

It delivers:

- AES-256-GCM secret storage with key ids.
- Platform URL and username validation, with no fetching of user URLs.
- GitHub App web flow (PKCE + state) and fine-grained PAT fallback via Octokit, with token
  refresh, revoke on disconnect and repository ranking.
- Hugging Face public API sync.
- The job queue and an in-process worker with lease, backoff and rate-limit handling.
- Onboarding and connection endpoints.
- `onboardingRequired` in `/session`, and a 403 `ONBOARDING_REQUIRED` from the dashboard.
- The guarded dev-account script.

Provider HTTP is injectable (`integrations` in `buildApp`) so tests never reach GitHub or
Hugging Face.

**Step 5: Backend profile service.** Owns:

- `src/modules/intelligence/{profile-service,profile-routes,summary,readiness-notes}.js`
- `test/intelligence-profile*.test.js`

It delivers:

- The canonical service: `getMyStudentProfile`, `getAuthorizedStudentProfile`,
  `getStudentRanking`, plus the officer helpers.
- `GET /student/skills/profile`.
- Officer `categories`, the directory and export, `overview/charts`, `students/:id/profile`
  (officer and ai purposes), `students/lookup`, `skills/students`.
- `POST /student/skills/summary`: generate with evidence ids, then review or hide.
- A descriptive readiness list with no numeric score.

Steps 4 and 5 run in parallel.

**Step 6: Web.** These run after step 5's contract is final. Three parallel tracks:

- **6a Student portal:**
  - Owns `src/app/student/onboarding`, `src/app/student/connections/**` (including the GitHub
    callback route handler), the dashboard intelligence sections, student nav entries, the
    `/student/api` proxy allowlist and student fetch helpers.
  - Delivers a 4-step onboarding (identity, six platform cards, visibility, review), a server
    redirect in the student layout, a connections page and dashboard sections.
- **6b Placement portal:**
  - Owns `src/app/placement/categories/**`, overview chart components (hand-built SVG with
    hidden data tables), `src/app/placement/students/[id]`, the Student Analytics "View student
    profile" button, the export route `ranked` resource, the Workspace nav item and placement
    types and server helpers.
  - Must not overwrite the uncommitted `Reports.tsx` change; build on it.
- **6c F.R.I.D.A.Y.:**
  - Owns `src/features/assistant/**` and `src/app/placement/friday-api/**`.
  - Delivers new tools (`student_profile`, `skill_profiles`, a `category` argument on
    `rank_students` using dense ranks), a `profile_link` SSE event rendered as a button bound to
    tool output, and prompt updates allowing provenance labels.

**Step 7: Validation and report.** In both repos:

- Typecheck, unit tests, backend suite (excluding the hanging MCP file), the web UI harnesses
  extended for the new pages at desktop, 27 inch and mobile widths in both themes, and the
  production build.
- An independent review pass for correctness and security.
- Dated `VALIDATION.md` entries.
- The final report covering the 22 items in the brief.

Nothing is committed, pushed or deployed. Migrations are applied only after review by the user.

### Needs the user

- Rotate the credentials leaked in backend commit `abe6703`.
- Register a GitHub App (callback `http://localhost:3000/student/connections/github/callback`)
  and supply its client id and secret, to test the real GitHub flow.
- Generate `INTEGRATION_ENCRYPTION_KEYS`.
- Provide an isolated Supabase project if the dev test account is wanted.
- Review the migration, then apply it with `npm run db:migrate` when ready.
