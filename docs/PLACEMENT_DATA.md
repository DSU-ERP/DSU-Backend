# Recorded placement observations

Companies, drives, interests, registrations, rounds and offers are managed through
the protected workspace and audited Supabase RPCs. Student imports remain unchanged.
No production example data is seeded.

For recorded tests, points or predictions, prepare a JSON file with three optional
arrays: `tests`, `points`, `predictions`. Each record needs an existing student's exact
`usn`. Unknown fields, unmatched USNs, duplicate identities and invalid numbers fail
the transaction. Older observations cannot overwrite newer ones. This tool does not
generate predictions.

From the API folder, with the ignored operator environment configured:

```powershell
node --env-file-if-exists=.env scripts/import-placement-records.js C:/path/recorded-data.json
node --env-file-if-exists=.env scripts/import-placement-records.js C:/path/recorded-data.json --apply
```

The first command validates and rolls back; the second saves. Successful imports
record a file hash and row count in the audit trail. Use verified institutional data.

| Array | Required fields | Optional fields |
| --- | --- | --- |
| `tests` | `usn`, `assessment_id`, `assessment_name`, `tier` (1 or 2), `score`, `max_score`, `completed_at` | `time_seconds`, `qualified_tier2`, `classification` (Basic/Medium/Advanced), `indicators`, `flagged`, `auto_submitted` |
| `points` | `usn`, `academic`, `github`, `domain`, `updated_at` | `breakdown` object |
| `predictions` | `usn`, `readiness` (job-ready/mid-level/entry-level), `risk` (low/medium/high), `generated_at` | String arrays: `roles`, `domains`, `skills`, `languages`, `strengths`, `risks`, `recommendations`; nullable 0–100 scores: `alignment`, `practical`, `theoretical`, `course_fit` |

Timestamps use ISO 8601 with timezone, e.g. `2026-10-14T10:00:00Z`. Scores are JSON
numbers. Missing predictions or points remain missing, never zero. Test indicators
can contain named numeric counts, booleans or short strings from the assessment source.

Combined test rankings use the latest completed attempt per tier. Underlying records
remain stored. Imported assessment classifications are separate from CGPA categories.
Refresh retrieves stored observations; it does not scrape GitHub or run tests.

## Access and verification

Only explicitly assigned officers can use the placement RPCs. Private tables are
not exposed to browser roles. Assignment preserves existing campus memberships:

```powershell
node --env-file-if-exists=.env scripts/grant-placement-officer.js existing-account@example.edu
node --env-file-if-exists=.env scripts/verify-placement-workspace.js
```

The verifier rolls back synthetic fixtures. `--preview` is only for testing new
migrations before installation, not an already migrated schema. Applied migrations
are checksummed and must not be edited after deployment.

Baseline eligibility is valid CGPA >= 6.75 with no backlog condition. Individual
drives independently enforce their CGPA, backlog and branch requirements. Already
placed candidates must move to a higher package category.
