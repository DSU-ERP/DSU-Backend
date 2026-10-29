# Students Ranking: architecture

Students Ranking is a Placement Officer module. It ranks students on CGPA, LeetCode evidence and GitHub project evidence, and explains every score. It reuses the existing canonical student record, onboarding, platform accounts, sync worker and officer authorization. It adds no new service, database, student identity or GitHub integration.

## Flow

```
Student finishes onboarding (GitHub, LeetCode, LinkedIn linked; consent given)
  -> platform account rows (student.platform_accounts)
  -> sync jobs (student.sync_jobs), run by the in-process sync worker
       GitHub: Octokit GraphQL + REST contributor stats (existing, extended)
       LeetCode: one public GraphQL request per sync (new)
  -> verified evidence (student.platform_metrics, student.github_repositories.evidence)
  -> ranking.request_recalculation(student)       same transaction as the sync result
  -> ranking.queue
  -> worker tick: drainQueue() -> engine.evaluateStudent() (pure) -> ranking.scores, topic_scores, score_history
  -> officer pages read placement.ranking_* (SECURITY DEFINER, officer-guarded)
```

When a student changes what they share (account visibility, profile visibility, onboarding completion, linking), the student route queues that student's own recalculation (`reason = 'student'`), so hidden data leaves the officer view on the next worker tick, about 5 seconds. A student can queue only their own record.

A nightly pass (`RANKING_INTERVAL_HOURS`, default 24) queues every student, so CGPA changes, stale evidence and new students are picked up even without a sync. Changing the current model also queues everyone, because the full-pass check is per model version.

## Components

| Part | Location |
| --- | --- |
| Scoring engine (pure, deterministic) | `src/modules/ranking/engine.js` |
| Model configuration v1 | `src/modules/ranking/model-v1.json`, seeded in `ranking.models` |
| Topic taxonomy | `src/modules/ranking/taxonomy.js`, seeded in `ranking.topics` |
| Recalculation (queue, batches, history) | `src/modules/ranking/service.js` |
| Officer routes | `src/modules/ranking/routes.js` |
| LeetCode client | `src/modules/intelligence/leetcode.js` |
| GitHub evidence extraction | `src/modules/intelligence/github.js` (`repositoryEvidence`, `contributorShare`) |
| Worker integration | `src/modules/intelligence/worker.js` (`rankingStep`) |
| Migration | `supabase/migrations/202610270001_student_ranking.sql` |
| Web module | `DSU_ERP/src/app/placement/students-ranking/`, `src/features/placement/components/StudentsRanking.tsx`, `src/features/placement/lib/ranking.ts` |

## API

All routes need an active placement officer (`placement.assert_officer()` in SQL). Queries are validated strictly; unknown keys are rejected.

- `GET /api/v1/placement/rankings/overview?batch&department&semester`: real counts, filter options, topics with evidence counts, current model.
- `GET /api/v1/placement/rankings?kind&topic&batch&department&semester&evidence&updated&show&search&page&limit`: one ranking view. `kind` is `academic`, `dsa`, `github`, `developer` or `topic` (requires an assessable `topic`). At most 100 rows per page.
- `GET /api/v1/placement/rankings/students/:id`: scores, full explanation, positions (university, batch, department in batch) and topic evidence for one student.

Cohort filters (batch, department, semester) decide who is ranked together. Search, evidence and freshness filters only hide rows, so ranks hold across pages and searches.

## Security controls

- Officers only. Students see nothing new in v1; their skills profile stays score-free.
- Platform evidence is used only when the student consented, the account is visible to officers and the student's sharing settings allow it (`platforms`, and `projects` for GitHub). Otherwise the component shows "Not shared".
- No credential, cipher, submitted figure, contact or profile text reaches the ranking tables or responses. `ranking.calculation_inputs()` reads only what scoring needs.
- Worker-only functions refuse any transaction without `app.sync_worker='on'`.
- No export endpoint exists in v1, so there is nothing to export without authorization.
- The provisional developer score is labelled as such everywhere and is never used for automatic rejection; no code path filters drives or offers by it.

## Deployment order

1. Apply `202610270001_student_ranking.sql` (after `202610220001`, `202610230001`, `202610260001`). It requires approval before it runs against ERP-DSU.
2. Deploy the backend. Readiness (`src/platform/database/readiness.js`) lists the new objects.
3. Deploy the web app.

Deploying the backend before the migration makes sync results fail with a missing-function error and the worker waits for the migration, as it already does for earlier migrations.
