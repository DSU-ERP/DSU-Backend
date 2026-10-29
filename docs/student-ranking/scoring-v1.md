# Scoring model `developer-competency-v1-experimental`

Status: experimental. Weights confirmed by the project owner on 27 October 2026 (50 / 30 / 20, every student with complete evidence eligible). It has not been reviewed as institutional policy.

All scores are on a 0 to 100 scale, rounded to two decimals. The engine is pure and deterministic: the same inputs and model always give the same result. Every constant below lives in `ranking.models.config`, not in code paths or pages.

## Component statuses

| Status | Meaning | Has a number |
| --- | --- | --- |
| `scored` | Current evidence, scored | Yes |
| `stale` | Evidence older than 30 days (`freshnessDays`); score kept and labelled | Yes |
| `not_linked` | No linked profile | No |
| `hidden` | Linked, but not shared with officers or no consent | No |
| `pending` | Linked, never synced | No |
| `unavailable` | Provider failed before any data, or no repository could be read | No |
| `disputed` | The same LeetCode username is linked by another student (case-insensitive) | No |
| `missing` / `invalid` | No CGPA / CGPA outside 0 to 10 | No |

Missing evidence is never scored as zero. A verified profile with no activity is scored (for example 0 solved problems scores 0); that is demonstrated absence, not missing evidence.

## Academic score

`Academic = CGPA / 10 x 100`. The 10-point scale is enforced by `erp.academics` (`cgpa BETWEEN 0 AND 10`). The raw CGPA is always shown. The CGPA ranking itself ranks the raw CGPA, read live from `erp.academics`, so it never waits for a recalculation.

The ERP has no "verification pending" state for CGPA: every stored CGPA is the imported institutional record.

## DSA evidence score (LeetCode)

From verified solved counts by difficulty:

- `W = min(easy, 150) x 1 + medium x 3 + hard x 6`
- `volume = 100 x (1 - e^(-W / 300))`
- `advanced = 100 x (1 - e^(-(medium + 2 x hard) / 150))`
- `DSA = 0.6 x volume + 0.4 x advanced`

Easy problems stop counting at 150, and both parts saturate, so thousands of easy problems cannot dominate. Contest rating is collected and shown but not scored in v1, because many students have never entered a contest and that is not evidence of weakness. Consistency is not inferred from a single snapshot.

## GitHub engineering evidence score

Repositories considered (all public, never forks):

- The student's own repositories (up to the 100 most recently pushed).
- Organisation repositories (added 27 October 2026 at the project owner's request): repositories of organisations the student belongs to (up to 50), and pinned organisation repositories. One counts only when GitHub's contributor statistics show the student authored at least 3 commits and at least 10% of all commits; without statistics nothing can be attributed, so it is not scored. Statistics are requested for the 10 most recently pushed organisation repositories.
- Repositories owned by another individual user are never counted.

Each considered repository is scored against six parts:

| Part | Points | Evidence |
| --- | ---: | --- |
| Implementation and depth | 30 | Code size (18, log scale from 1 KB to 1 MB), more than one language (4), lines added by the student in 52 weeks (8, log scale) |
| Organization and maintainability | 20 | Dependency or build manifest (8), source folders (4), license (3), .gitignore (2), top level of 40 entries or fewer (3) |
| Testing and reliability | 15 | Automated tests (9), continuous integration (6) |
| Documentation and reproducibility | 15 | README of 300+ bytes (5), 1,500+ bytes (4), description (2), homepage (2), topics (2) |
| Original contribution | 15 | Original repository (5), student's share of commits, full points at 50% or more (10) |
| Collaboration and maintenance | 5 | Pushed within 180 days (3) or a year (1.5), more than one contributor (2) |

Stars, forks and commit counts never add points. For an organisation repository the 5 "original repository owned by the student" points do not apply and leave its maximum, so its attribution rests on the student's commit share.

Points that need data GitHub did not provide (lines added and commit share come from contributor statistics for up to 10 recently pushed repositories) are removed from that repository's maximum instead of scoring zero. A repository is scored only when at least 70% of its points were observable. A repository whose files could not be listed (empty, no default branch) is not scored.

`repository score = 100 x earned / observable maximum`

Aggregation over the student's scored repositories, best first:

`GitHub = 0.95 x (0.5 x best + 0.3 x second + 0.2 x third) + breadth`

`breadth` is 1 point for each further repository scoring 40 or more, at most 5. Missing second or third repositories count as 0, so one excellent project scores about half of three excellent ones, and thirty trivial repositories score far below a few strong ones.

## Provisional developer score

`Developer = 0.5 x Academic + 0.3 x DSA + 0.2 x GitHub`

Calculated only when all three components are `scored` (current). Otherwise the student shows "Pending score" with the reason for each component. Weights are never redistributed. Eligibility: every student, in every programme, with complete current evidence (decision of 27 October 2026). The score describes software-oriented evidence, not engineering ability, and must never be used for automatic rejection.

`coverage` records the share of developer weight that has evidence (for example 0.7 when LeetCode is missing). `evidence_state` is `complete` (all three current), `partial` (CGPA plus at least one platform) or `pending`.

## Topics

- DSA topics: `100 x (1 - e^(-n / 20))`, where n is the largest LeetCode solved count among the topic's tags (tags overlap, so counts are never summed). At least 3 solved problems are required; below that the topic shows "Insufficient verified evidence".
- Project areas: the score of the strongest repository classified into the area. Classification is a fixed rule set over languages, repository topics, names, descriptions and root files (`classifyRepository`). It is project evidence, not subject mastery.
- Core subjects (OOP, testing, DBMS, OS, networks, computer organization, software engineering, AI) have no v1 source and always show "Not yet assessed".

## Ranking

Dense rank, highest score first. Ties share a rank and are listed by USN (C collation), then id. Only students with a number in the selected view are ranked.

## Reproducibility and versions

Each score row stores the evidence-derived explanation, component scores, statuses, weights, `input_hash` (inputs plus model version), `result_hash`, `evidence_synced_at` and `calculated_at`. `ranking.score_history` keeps the last 20 changed results per student. A new model is a new `ranking.models` row; making it current queues a full recalculation and scores are stored per model version, so old and new versions never mix.
