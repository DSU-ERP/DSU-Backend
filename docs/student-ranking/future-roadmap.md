# Students Ranking: roadmap

v1 uses only CGPA, GitHub and LeetCode. The model is built so new evidence plugs in without replacing the engine.

## Adding an evidence source

1. Store the evidence where it belongs (academic marks in the ERP schema, assessments in their module).
2. Extend `ranking.calculation_inputs()` with the fields scoring needs.
3. Add a pure component function in `engine.js` with the same status vocabulary.
4. Add topics or point existing ones at the new source (`ranking.topics.source`; extend its check).
5. Publish a new `ranking.models` row (for example `developer-competency-v2`) with its weights, make it current, and let the full pass recalculate. v1 scores stay stored under their own version.

## Planned sources

- MSE1, MSE2, semester-end and lab marks: subject scores for the core topics (DBMS, operating systems, networks, computer organization, software engineering, OOP), which v1 lists as "Not yet assessed".
- Placement department assessments and the competency pilot's reviewed assessments, once its rubrics are institutionally approved.
- Internships, certifications and research papers, as reviewed evidence.
- Domain-specific engineering assessments, so Mechanical, Aerospace, ECE and Robotics students are ranked on evidence that fits their programme rather than only on software evidence.

## v1 follow-ups

- LeetCode ownership proof: show the student a short code to place in their LeetCode profile summary, check it once during sync, and mark the account platform-verified.
- Contributions to other people's repositories (`contributionsCollection.commitContributionsByRepository`).
- Officer-triggered recalculation for one student, rate limited and audited.
- An audited CSV export of a ranking view, reusing the existing export budget (`placement.events`).
- Students seeing their own component scores (not ranks), if approved.
- Institutional review of the rubric and weights before the model status moves from `experimental` to `approved`.
