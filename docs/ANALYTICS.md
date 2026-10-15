# Direct Supabase portal access

Migration `003_supabase_portal_reads.sql` adds a restricted RPC for the website
to read existing Supabase records without the Render service. The SQL is
generated from the shared category rules by `scripts/generate-portal-migration.js`.
Existing API routes remain available and use the same definitions.

Run `node --env-file-if-exists=.env scripts/verify-portal.js` to verify the
installed functions and authorization using rolled-back test records.
Run `node --env-file-if-exists=.env scripts/check-supabase-portal.js` to compare
the live Supabase summary with the existing API queries, without logging PII.

# Final CGPA categories and analytics

Implemented 13 October 2026. The portal adds exactly two navigation items for administrators and staff: **Batch Analytics** and **Student Analytics**. Existing portal sections keep their layout.

## One canonical definition

`src/lib/analytics/categoryRules.js` owns the typed category identifiers (JSDoc `CategoryId`), bounds, names, display ranges, scale validation, exact decimal classifier, and parameterized PostgreSQL CASE expression. The frontend receives labels/ranges/counts from this API and contains no category cutoff constants.

| ID | Name | Exact rule | Display range |
| --- | --- | --- | --- |
| advanced | Advanced | CGPA >= 8.50 | 8.50 and above |
| medium | Medium | CGPA >= 6.75 and CGPA < 8.50 | 6.75 – 8.49 (two-decimal convention) |
| needs-improvement | Needs Improvement | CGPA < 6.75 | Below 6.75 |

These rules apply only to valid CGPA. The existing database CHECK constraint configures a 0–10 scale, inclusive; zero is valid. NULL or absent academic records are missing. Out-of-range/nonfinite values are invalid. Both are reported as data quality outside the three categories. The database normally prevents invalid numbers; query verification also tests legacy/invalid numeric values in temporary fixtures.

SQL compares native `numeric`, never rounded strings or floating-point casts. The JS helper compares decimal integers with BigInt. CSV import preserves exact decimal text if converting to a JS number would change it; ordinary values retain their existing normalized representation. No existing records are rewritten or re-imported by this change.

## Pages and endpoints

- `/portal/batch-analytics`: counts, average CGPA, performance counts and unclassified totals per source batch.
- `/portal/analytics`: Student Analytics, with exactly three linked category panels, data quality, and separate statistical distribution bands.
- `/portal/student-categories`: alias of Student Analytics.
- `/portal/student-categories/:category`: ranked and paginated category directory, student details, and administrator CSV export.

API endpoints use the same paths without `/portal`: `/analytics`, `/batch-analytics`, `/student-categories`, `/student-categories/:category`, `/student-categories/:category/export`. They work under service-protected `/v1` and combined-mode `/api/v1`. The separate backend gateway forwards the same allowlisted routes.

Filters: `batch` (four-digit source batch), `department` (exact department short name, `__missing__` for NULL), and `search` (case-insensitive literal substring in name or USN/enrollment). Lists additionally accept integer `page` and `limit` (1–100). Filter forms reset pagination. Category links, pagination, batch links and exports preserve cohort filters. Unknown categories return 404. Invalid filters return 400.

The denominator is the full filtered cohort before applying a category. Within a consistent repeatable-read transaction:

`advanced + medium + needs-improvement = valid`

`valid + missing + invalid = selected total`

The one-to-one academic join and unique student key prevent duplicate students. A reconciliation assertion protects the summary. Statistical bands remain a separate definition: below 6, 6–<7, 7–<8, 8–<9 and 9–10.

Ranking uses exact CGPA descending within the selected category/cohort. Ties share competition rank (1, 1, 3); USN using C collation and then UUID give deterministic display order across pages. Display rounds CGPA to two decimals with stored precision available in the table tooltip; exports retain full stored precision.

## Placement and permissions

The confirmed placement policy is valid CGPA ≥ 6.75 for Eligible, valid CGPA below 6.75 for Not Eligible, and missing/invalid CGPA for Unclassified. No backlog or attendance gate is applied. `src/lib/analytics/placementPolicy.js` is the shared policy; migration 005 installs it in Supabase and updates summaries, lists, details and exports. Generate/check migration 005 with `node scripts/generate-placement-migration.js [--check]`. Category eligibility percentages use category size; batch eligibility percentages use the selected cohort. Analytical ≥6.0 counts remain separate.

Admin and staff can view analytics and category lists. Students cannot access these cohort-wide endpoints. Only administrators may export; exports are audited, limited to 20,000 matching records and five requests/minute, contain no contact/financial fields, and escape spreadsheet formulas. Original role and RLS protections remain in force. Export operations are never automatically retried.

## Validation and rollout

```powershell
npm test
npm run test:analytics-db
```

The second command uses the existing operator connection solely for temporary tables, then rolls back. It checks all mandatory boundaries (including 8.499, 6.749, zero and NULL), greater precision, invalid values, missing academic rows, tied ranks, disjoint categories, empty cohorts, literal search escaping, filters, pagination, batch totals and statistical-band reconciliation against PostgreSQL itself.

WEB also runs its unit tests and production build; Backend has a forwarding test for all new routes. For the current direct Supabase path, apply migration 003 and deploy WEB. The original API analytics routes remain optional; deploy API (and DSU-Backend if using that gateway) only when consumers need those routes. No paid hosting change is required. Source changes do not deploy automatically unless pushed to the watched branch.

Executed validation: API 41 tests, Backend 4 tests, WEB 20 tests; PostgreSQL temporary-fixture verification and Next.js production build passed. A read using the restricted runtime role and the existing administrator identity reconciled the current dataset: 5,082 total = 5,073 valid + 9 missing + 0 invalid. Categories: Advanced 894, Medium 2,238, Needs Improvement 1,941. These are observed results, not application constants. No student data was changed. Visual browser testing and hosted rollout have not been performed.
