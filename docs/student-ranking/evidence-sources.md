# Evidence sources (v1)

## CGPA

`erp.academics.cgpa`, the imported institutional record. Read only, never modified. Students cannot change it.

## GitHub

Connected during onboarding through the GitHub App (web flow with PKCE) or a fine-grained personal access token, both handled by the existing Octokit integration. Tokens are encrypted with AES-256-GCM in `student.platform_credentials`, are readable only by the worker with `app.credential_access='on'`, and are never logged or returned. Expiry and revocation already stop retries (`CREDENTIAL_INVALID`) without deleting earlier verified evidence.

Only public repositories are read; private repositories are never requested. The sync reads the student's own non-fork repositories and the public non-fork repositories of organisations they belong to (`ownerAffiliations: ORGANIZATION_MEMBER`; organisations that hide membership may not list them). Organisation repositories are credited only for the student's own commits (see scoring-v1.md). Per repository the sync stores, in addition to the existing fields:

- root file and folder names (names only, never contents): manifests, test folders and files, source folders, `.gitignore`, Docker files
- CI workflow count (`.github/workflows`) and other CI files
- release count and disk usage
- whether the owner is an organisation or a user
- the student's commit share and contributor count, from contributor statistics, for up to 10 recently pushed own repositories and 10 organisation repositories

These cost one extended GraphQL query plus the contributor statistics requests that were already made. Duplicate GitHub identities cannot occur: one linked student per GitHub account id is enforced by a unique index.

Every linked GitHub account is synced once more to pick up evidence and organisation repositories (its latest snapshot lacks the `organizationRepositoryIds` marker until then).

Limitations: contributions to repositories owned by other individuals, and to organisations the student is not a member of, are not scored in v1. A commit share says who committed, not who wrote every line. Classification of project areas is keyword based.

## LeetCode

LeetCode publishes no documented API. With the project owner's approval (27 October 2026), the sync worker reads the same public GraphQL query LeetCode's own profile page uses, for the username the student linked:

- solved counts by difficulty (`submitStatsGlobal`)
- problems solved per topic tag (`tagProblemCounts`)
- contest rating and contests attended (`userContestRanking`), when the student has entered contests

Collection is batched and paced (project owner's request, 27 October 2026, to keep it efficient):

- The worker claims LeetCode jobs as a group of up to 10, and the client merges their lookups into one POST to `https://leetcode.com/graphql` using GraphQL aliases. A missing username fails on its own without failing the batch; duplicate usernames share a slot.
- Requests are at least 1.5 seconds apart, so a full refresh of 1,000 students is about 100 requests over a few minutes.
- A 429, or a 403 from LeetCode's bot protection, pauses every LeetCode lookup until the reset (15 minutes for a 403). Lookups during the pause fail immediately without a request and are rescheduled without using up retry attempts.
- 15 second timeout, no redirects, 1 MiB response cap, defensive parsing. Calls happen only in the background worker on the existing schedule (`SYNC_INTERVAL_HOURS`, default 24) or on a student's rate-limited manual refresh, never during page rendering.

Risks: the endpoint is not a supported API. It can change or block automated requests without notice, and LeetCode's terms restrict automated access. If it stops working, LeetCode components become `unavailable` for new students and `stale` after 30 days for existing ones; nothing is fabricated.

Ownership: the username is student-submitted (`ownership = student_submitted`). Usernames claimed by more than one student are excluded (`disputed`).

Name check (`src/modules/intelligence/name-match.js`): when a student links LeetCode, the username is compared with their official name; after each sync, the name on the LeetCode profile is compared too. A match or near match (for example `shreyas_kr`, `kshreyas`, `sidvenkat`, or the profile name "Ananya R" for Ananya Rao) is stored as `verified`, anything else as `unverified` (`student.platform_accounts.name_match`, with `name_match_source` `username` or `profile_name`). Students see a Verified or Unverified badge on their LeetCode card; officers see it next to the DSA score and in the explanation. It is a plausibility check, not proof of ownership (two students named Rahul can both match `rahul`), and it does not change any score. The LeetCode profile name is used for the check only and is not stored. A profile-bio verification code remains on the roadmap. Student-typed figures (`submitted`) remain stored and labelled but are never used for scoring.

Existing linked LeetCode profiles are moved from link-only to sync by the migration and collected on the next scheduled pass.

## Freshness

Evidence older than 30 days is `stale`: still shown, never part of a developer score. Every row shows when its evidence was collected and when the score was calculated.
