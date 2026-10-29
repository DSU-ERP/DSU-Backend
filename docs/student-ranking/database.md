# Students Ranking: database

Migration: `supabase/migrations/202610270001_student_ranking.sql`. Additive and backward compatible. It must be approved before it is applied to ERP-DSU. It was validated against the full migration chain in the in-memory PGlite database used by the test suite; it has not been applied to any Supabase project.

## Changes to existing objects

- `student.github_repositories.evidence jsonb NOT NULL DEFAULT '{}'`: structural evidence, at most 8,000 bytes. Filled on each repository's next sync.
- `student.platform_accounts.name_match` (`verified` / `unverified`) and `name_match_source` (`username` / `profile_name`): the LeetCode name check. Filled when a student links LeetCode and at each sync.
- `student.sync_student_name(account)`: worker-only; returns just the official name of the account's student for the name check.
- Linked LeetCode accounts with `auth_method='link_only'` become `public_api` with `sync_status='pending'`. This is the only data update, and it changes no student record, CGPA or submitted figure.

No table, column, policy or function is dropped or rewritten.

## New schema `ranking`

| Table | Purpose |
| --- | --- |
| `models` | Versioned scoring configuration; exactly one `current` (partial unique index). `config.version` must equal the key. |
| `topics` | Competency taxonomy (38 topics). `source` is `leetcode`, `github` or NULL (not assessable yet). |
| `scores` | One row per student and model: component scores and statuses, coverage, evidence state, full explanation, input and result hashes, evidence and calculation timestamps. Checks tie every number to a scoring status. |
| `topic_scores` | Topic evidence per student and model, cascading with its score row. |
| `score_history` | Append-only copy of each changed result (last 20 per student). |
| `queue` | Students waiting for recalculation (`sync`, `scheduled`, `model`, `manual`, `student`). |
| `runs` | Audit of processed batches and full-pass requests. |

Indexes: `scores(model_version, dsa|github|developer DESC)` (partial, non-null), `topic_scores(model_version, topic_code, score DESC)`, `score_history(student_id, calculated_at DESC)`, `runs(model_version, kind, started_at DESC)`. Cohort filters use the existing `erp.students` indexes.

## Functions

| Function | Caller | Guard |
| --- | --- | --- |
| `ranking.calculation_inputs(uuid[])` | sync worker | `student.sync_worker()`; at most 1,000 ids |
| `ranking.request_recalculation(uuid, text)` | sync result writer, student routes | `student.sync_worker()`, or reason `student` for the caller's own record |
| `ranking.request_full_recalculation(interval)` | sync worker | `student.sync_worker()`; advisory lock; once per window per model |
| `placement.ranking_filters(jsonb, text[])` | ranking RPCs | validates filters (builds on `placement.intel_filters`) |
| `placement.ranking_overview(jsonb)` | `dsu_api` | `placement.assert_officer()`, owned by `dsu_placement` |
| `placement.ranking_list(jsonb)` | `dsu_api` | same |
| `placement.ranking_student(uuid)` | `dsu_api` | same |

## Access

RLS is enabled on every ranking table. `PUBLIC`, `anon` and `authenticated` have no access.

- `dsu_api` writes scores only under `student.sync_worker()` policies. Student requests never read or write ranking data.
- `dsu_placement` reads models, topics, scores, topic scores and runs under `placement.authorized()` policies, through the officer RPCs.

## Rollback

The module can be disabled by removing the routes and the worker step; the tables are inert without them. To remove the data, drop schema `ranking` and the `evidence` column. LeetCode accounts can be returned to link-only with `UPDATE student.platform_accounts SET auth_method='link_only', sync_status='not_applicable' WHERE platform='leetcode' AND auth_method='public_api'`.
