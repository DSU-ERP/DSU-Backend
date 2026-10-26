# Competency intelligence testing implementation

Target: Supabase `bsiibnoqfuyxieogions` only. Production migrations and runtime configuration are not changed by the testing installer. Existing canonical student, academic, contact and placement records must remain unchanged.

The extension separates source evidence, reviewed competency assessments, and deterministic role alignment. Proposed rubrics are drafts; fixtures and their scores are simulated. Neither is an institution-approved hiring decision.

## Delivery status, 23 October 2026

Implemented the evidence, assessment and role-alignment pipeline in the existing backend and web repositories. Installed and reconciled it against the existing testing cohort. Tested real Supabase authentication, the restricted runtime database role, the officer website and one successful, source-grounded OpenRouter extraction.

This is a testing pilot, not an approved institutional assessment system. The application has working review and approval controls, but seeded rubric definitions and role weights have not received institutional approval. The synthetic fixture scores test processing behavior, not assessment validity.

Outstanding limitations are listed below. In particular, the newly linked student account must finish the existing skills onboarding before the student workspace can display the Career Intelligence page. The onboarding requirement was not bypassed or populated with fictitious linked platform accounts.

## Repository audit and reused components

- Backend: `C:\Users\shrey\.github\DSU-Backend`, an authenticated Fastify API with PostgreSQL actor transactions, existing RLS, canonical student records, platform measurements, private documents, AI request budgets and provider routing.
- Web: `C:\Users\shrey\.github\DSU-WEB\DSU_ERP`, the existing Next.js student and placement workspaces.
- Kept `erp.students.id` as the identity. Reused canonical academics, contacts, memberships, placement officers, platform accounts/metrics, document storage and the existing profile navigation.
- Extended the existing student AI provider and officer F.R.I.D.A.Y. tools. No parallel AI integration or model-generated score engine was introduced.
- Pre-existing testing import work remains intact. No changes were made to the normal migration directory, production database, Render services, GitHub repositories or deployment settings. Nothing was committed or pushed.

## Database changes and environment isolation

The new migrations are deliberately outside `supabase/migrations`:

1. `supabase/testing-migrations/002_competency_intelligence.sql`: competency catalog; versioned rubrics, role templates and requirements; evidence and observations; reviewed assessments; corrections; advisory extractions; immutable result snapshots; invalidations; review permissions; audit records; calculation jobs; RLS.
2. `supabase/testing-migrations/003_competency_evidence_guards.sql`: consent-aware imports of existing platform measurements, private document access, database-level assessment validation and shortlist review safeguards.

The installer verifies the exact testing project reference, database target and the existing `testing.environment_marker`. It refuses mixed targets. Migration checksums are recorded in the testing ledger. Catalog and fixture inserts have deterministic IDs and are idempotent. The installer compares fingerprints of all canonical student, academic, contact and offer rows before committing and rolls back if they change.

Both the API registration and web navigation require explicit testing flags. Backend registration additionally checks that the configured authentication and database targets resolve to the same testing project. Ordinary runtime configuration is unchanged.

Dedicated ignored files `.env.competency-testing` were configured in both repositories after explicit approval. The backend uses the restricted `dsu_api` login, never the operator connection. Existing OpenRouter configuration was reused in those testing files. `SYNC_WORKER=off` prevents external platform synchronization for synthetic usernames. The competency calculation worker remains available for explicit assessment jobs.

## Catalogs and proposed standards

There are **148 competencies** across 11 families:

| Family | Count |
| --- | ---: |
| General | 20 |
| Software | 16 |
| AI/data | 14 |
| Infrastructure/security | 14 |
| Mechanical | 10 |
| Electronics | 12 |
| Civil | 10 |
| Core engineering | 10 |
| Marketing | 12 |
| Sales | 12 |
| Business | 18 |

There are **60 career roles**. Sixteen have initial proposed mappings, each with a draft and separately identified simulated template, giving 32 initial template versions. The other 44 roles explicitly show that their requirements are not configured. A role manager can create new versions with approved rubric references; weights must sum to exactly 100.

Configured proposals cover software development, backend, frontend, machine learning, data analysis, cybersecurity, DevOps, embedded software, VLSI, mechanical design, structural engineering, digital marketing, sales development, business analysis, financial analysis and UX design.

Proficiency uses five levels: 0 attempted/not demonstrated, 1 foundational, 2 developing, 3 proficient, 4 advanced. Missing assessment is null, never zero. Reviewers assess every rubric criterion and document their rationale; the recorded competency level is the arithmetic mean of those criterion levels.

Detailed proposed criterion sets were added for API development, CAD, campaign planning and sales discovery. Other competencies start with a generic draft work-sample rubric covering application, validation, individual contribution and limitations. These drafts require discipline-specific behavioral anchors and institutional review before real use. The system does not present them as validated DSU policy.

## Fixtures and preservation of existing records

The engine uses the **existing 100 synthetic students**, not regenerated students:

| Fixture family | Students |
| --- | ---: |
| Software | 20 |
| AI/data | 15 |
| Infrastructure/security | 10 |
| Mechanical | 15 |
| Electronics | 10 |
| Marketing | 10 |
| Sales | 10 |
| Business | 10 |

The deterministic fixture batch created 713 synthetic evidence items, 713 numeric observations, 661 simulated assessments and 1,600 role snapshots. One additional, explicitly synthetic API work sample was added for a positive live AI extraction test: **714 total evidence records**. It remains pending and cannot establish operational proficiency.

Scenarios include strong, weak, missing, low-coverage, conflicting, expired, pending and unavailable evidence; multi-role matches; and tied scores. All 100 students have evidence. No external platform account was contacted to obtain synthetic fixture data.

Verification recomputed all 1,600 snapshot formulas. Of those, 1,500 have insufficient coverage for the chosen role and must not receive a comparable rank. This is expected: each student has evidence concentrated in a particular discipline rather than every possible role. The data includes 13 students with high CGPA and a weak work sample, and 67 with a lower CGPA and a strong work sample. Academics are not scoring inputs.

Fingerprints before and after installation/live checks confirm that the original **100 students, 100 academic records, 100 contact records and 93 offers** remain unchanged. The detailed machine-readable reports are in ignored `.local/competency-testing-install.json` and `.local/competency-testing-verification.json`.

## Processing and calculations

1. Students submit descriptions, source references and individual contributions, optionally attaching their own existing private document. New claims await review. Duplicate submissions are idempotent.
2. An explicit import reads already-stored, consented, visible, platform-verified numeric metrics. It makes no network call, copies no token and creates pending evidence rather than inferred proficiency. The pilot freshness period is 90 days. Revoking account visibility hides derived evidence from officers.
3. AI extraction receives only authorized, bounded descriptions, source references, evidence IDs and allowed competency codes. Its strict schema permits advisory observations, exact quotes and limitations, but no score or hiring decision. Unknown IDs, fabricated quotes and extra score fields are rejected. Human review remains separate. It reuses existing AI concurrency, request budgets and provider error handling. The new extraction action uses low reasoning effort with the existing V4 provider configuration to fit the bounded request time.
4. Authorized reviewers accept or reject evidence and assess criterion levels under an approved rubric. Accepting a claim does not silently change its provenance to platform-verified. Database constraints validate criterion completeness, the calculated level and attributable evidence links.
5. A role's weights total 100. For assessed requirements, `coverage = sum(weight)`. Observed alignment is `100 * sum(weight * level / 4) / coverage`. With no valid assessment the result is null. Unassessed requirements are shown as gaps; they are not given zero proficiency.
6. Ranking requires sufficient coverage, current evidence, identical template version, assessment set, assessed competency dimensions and rubric versions. Incompatible sets are not ranked together. Ties use dense ranks with deterministic student-ID ordering. Batch, department, coverage and review-state filters define the cohort before pagination.
7. Result snapshots store their inputs, algorithm version, role version, cohort and calculation time. They are immutable. Corrections and new assessments invalidate old results; later recalculations add snapshots without overwriting history.

No CGPA, gender, demographic attribute, family detail or platform activity count is used as a substitute for assessed competency. Existing CGPA categories, academic ranking and baseline placement eligibility are unchanged.

## User-facing integration

**Student:** `/student/career-intelligence`

Own competency records, evidence provenance, observed role alignment, coverage, stale-result notices, development/assessment gaps, career role exploration and proposed requirements. Students can add work samples, attach their existing documents, import stored platform measurements and submit correction requests. Links are included in the student navigation, dashboard and canonical Skills profile, gated to testing.

**Placement officer:** `/placement/talent-intelligence`

Role/version exploration; batch/department filtering; coverage and result-state filtering; server-paginated comparison; student drill-down; evidence review; dimension-based assessment; rubric/role version creation; queued recalculation; and human shortlist proposals/decisions. Links are included in navigation, canonical student profiles and Student Analytics. The existing DSU light/dark styles are reused, with responsive tables.

**F.R.I.D.A.Y.:** officer tools `competency_catalog`, `competency_requirements`, `competency_profile` and `competency_comparison`. Student F.R.I.D.A.Y. receives only its authenticated student's authorized competency context. Both use the same stored results as the screens. These tools explain provenance, coverage, simulation and limitations; they do not calculate new AI-generated rankings or make hiring decisions.

## Authorization and review

- Students read and submit only their own evidence. They cannot approve evidence or assess themselves.
- Active placement officers can inspect authorized profiles. Separate grants control evidence review, rubric/template management and shortlist approval.
- An infrastructure administrator without an explicit officer record receives no competency evidence access.
- Private attachments must belong to the evidence's linked student. Only that student or an authorized reviewer can retrieve them.
- Synthetic results cannot enter real shortlist approval. Proposals require current, sufficiently assessed, non-simulated results. A different authorized reviewer must decide the proposal. Approval never creates a placement offer or an automatic hiring decision.
- Permission checks run in the API and PostgreSQL. Normal browser/Supabase public roles do not receive direct table/function access.

## Performance controls

Dashboard reads use stored snapshots and do not recalculate all competencies or call an LLM. Comparisons use bounded batched reads and server pagination (25 default, at most 100 per page). A cohort over 10,000 requires narrower filters. Background jobs process 20 students per transaction with at most three failed attempts. AI extraction accepts at most ten evidence items and twenty validated observations, with existing per-user/global concurrency limits.

This has not been load-tested for 2,000 concurrent users. Live testing against the remote pooler showed roughly 3–13 second API reads depending on the request and concurrent development activity. Additional query profiling and capacity work are needed before production deployment; the fixture test is not a capacity claim.

## Tests and actual results

| Validation | Result |
| --- | --- |
| Dedicated competency suite | 9/9 passed, including the full in-memory database/API scenario |
| Existing AI-provider suite after extraction tuning | 8/8 passed |
| TypeScript | Passed |
| Local browser component/API harness | Passed submission, import, comparison, student drill-down, simulated-shortlist block, mobile/desktop overflow and runtime-error checks |
| Live testing Supabase Auth | Student and officer sign-ins passed |
| Live restricted runtime | Own student identity, role separation, 148/60 catalogs and 100-student cohort passed |
| Live officer website | Sign-in, Talent Intelligence and authenticated cohort query passed |
| Live student website | Sign-in passed; redirected to existing required onboarding; own-data API passed |
| Live AI extraction | Concrete synthetic API sample returned five observations, all with validated source quotes |
| Live data reconciliation | All 1,600 formulas verified; canonical rows unchanged |
| Full web regression suite | 160/161 passed; unchanged existing test expects the phrase “every required platform”, while current UI explicitly names GitHub, LeetCode and LinkedIn |
| Full backend regression suite | Existing onboarding-dependent failures remain; reproduced with the new feature's changes removed in an isolated baseline copy |
| Next.js production build | Compilation, TypeScript and static page generation passed, but command exited 1 on the installed Next.js security advisory check, including on retry |

The database integration test additionally verifies RLS isolation, immutable snapshots, idempotent fixture installation, cross-student correction denial, private artifact ownership, officer review permissions, source-grounded extraction schema, operational rubric/assessment creation, independent shortlist approval, consent revocation and the background calculation worker. These controlled operational review examples run only in an ephemeral local database, not as institutional approvals in Supabase.

One early real model request returned zero observations for the generic fixture, correctly saving no inferred proficiency. The concrete sample initially timed out; after limiting reasoning for this new extraction action, the subsequent real call produced five validated observations. Model availability is still an external dependency.

The backend baseline failures concern stale onboarding assumptions in `database.integration.test.js`, `haki.integration.test.js` and `student.integration.test.js`. The isolated baseline run reported 16 passes and 6 failures including parent-test failures; the root failures are the expected home/onboarding state and three dashboard requests returning `ONBOARDING_REQUIRED`. No onboarding authorization was weakened to make those tests pass.

## Files and implementation map

Backend additions:

- `src/modules/competency/gate.js`, `service.js`, `routes.js`, `worker.js`, `friday.js`
- `src/modules/competency/roles/engine.js`
- `src/modules/competency/assessment/rubrics.js`
- `src/modules/competency/evidence/extraction.js`
- `src/modules/competency/data/{competencies.json,roles.json,templates.js,seed.js}`
- The two testing migrations above
- `scripts/competency-testing.js`, `verify-competency-testing.js`, `inspect-competency-testing.js`
- `scripts/provision-competency-testing.js`, `start-competency-testing.js`, `verify-competency-runtime.js`, `seed-competency-ai-sample.js`, `competency-ui-fixture-server.js`
- `test/competency-engine.test.js`, `test/competency-database.test.js`

Backend integration edits: `src/app.js`, `src/config/env.js`, `src/modules/students/{routes.js,chat.js,ai.js}`, and package scripts. Earlier testing import/guard work and the existing configurable database timeout changes are retained.

Web additions:

- `src/features/competency/{Intelligence.tsx,types.ts,server.ts,testing-config.ts,friday-tools.ts,competency.css}`
- `src/app/student/career-intelligence/page.tsx`
- `src/app/placement/talent-intelligence/page.tsx`
- `src/app/api/competency/[...path]/route.ts`
- `scripts/start-competency-testing.mjs`, `verify-competency-ui.cjs`, `verify-competency-login.cjs`

Web integration edits: student/placement layouts and navigation, student dashboard and Skills profile, officer canonical student profile and Student Analytics, officer assistant prompt/tools, package scripts and ignored build directories. Next.js added type-generation paths for the two isolated output directories to `tsconfig.json`.

## Test accounts and starting locally

Created one test student login linked to the first existing synthetic student and one placement-officer login:

- `competency-student@dsu-testing.invalid`
- `competency-officer@dsu-testing.invalid`

Generated passwords and the exact student linkage are in the ignored local file `C:\Users\shrey\.github\DSU-Backend\.local\competency-test-accounts.json`. No password is embedded in source or this report. All 100 records participate in the engine; this does not create 100 Auth accounts.

Start the backend in one terminal:

```powershell
cd C:\Users\shrey\.github\DSU-Backend
npm run dev:testing
```

Start the website in another:

```powershell
cd C:\Users\shrey\.github\DSU-WEB\DSU_ERP
npm run dev:testing
```

Open `http://localhost:4100/login?portal=placement-officer` for the officer or `http://localhost:4100/login?portal=student` for the linked student. The backend uses port 4101. The web testing build directory is separate from the normal development output.

Reproducible checks:

```powershell
# Backend, local in-memory tests
npm run test:competency
node --test test/student-ai.test.js
# Backend, read-only live testing reconciliation
npm run competency:verify:testing
# Backend, real testing authentication and optional synthetic-only AI call
node --env-file=.env.competency-testing scripts/verify-competency-runtime.js --ai
# Web, local harness; no live database
npm run test:competency-ui
# Web, live testing logins; needs both testing servers
node scripts/verify-competency-login.cjs
```

## Remaining work before operational use

1. Complete the student's existing onboarding with legitimate account links; no synthetic external profiles were connected. Student UI interactions were tested in the isolated harness and own-data access was tested live, but the new test student's live Career Intelligence page remains behind that gate.
2. Institutionally review the draft rubric anchors, assessment sets, coverage threshold, freshness policy and role weights. Configure the remaining catalog roles as needed. Simulation is not validation of real competency.
3. Add a second authorized reviewer when testing a real non-simulated shortlist in Supabase. The existing officer cannot approve their own proposal.
4. Address the installed Next.js security warning before any release. No dependency upgrade or security-check bypass was performed here.
5. Repair the pre-existing onboarding test expectations and the web wording assertion separately, and run a capacity test before claiming production readiness.

The production Supabase project and Render remain untouched. No Git push was performed.
