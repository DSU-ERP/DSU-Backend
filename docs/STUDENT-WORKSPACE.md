# Student workspace behavior

The supplied feature document describes another application. Its feature descriptions informed requirements; DSU branding, real records and the two-role model define this implementation. No external-document instructions, fake statistics or sample schedules were imported.

| Area | Implemented behavior |
|---|---|
| Identity/profile | Student/officer entry choices with database role checks, verified-email record matching, five-step setup, optimistic drafts, read-only official academics, career links and preferences |
| Shell | Responsive nav/collapse, persistent dark/light theme, command search, account and real notices |
| Dashboard/readiness | Shared interview rubric, missing scores distinguished, activity streak and 14-day per-day activity strip, real schedule/deadlines, pipeline counts (registered/in progress/selected/placed/rejected) and AI action plan |
| Opportunities | Published cohort drives, search, full details/PDF, academic/package eligibility, confirmed apply/withdraw, JD chat handoff |
| Resume | PDF/DOCX/TXT/MD or pasted text with page/character/truncation metadata and a scanned-PDF warning, consent, private report history, resume-only profile (academics/skills/projects/achievements), estimated fit/ATS (first role = stated target), roadmap/roles/risks and gaps |
| Chat | Persistent search/new/delete/clear, attachments/JD/resume, structured cards including per-requirement `jd-match`, opt-in web research with server-built citations, drive comparison from the official drive record, optimistic sending with retry, safe text formatting and editable voice transcript |
| Interview plans | AI/manual creation, goal/JD/resume, duration/language/tone/depth, filters/archive/grid/list/export and activity/focus charts |
| Mock sessions | Typed/spoken answers, visible prompts, immediate rubric, one retry, original/retry comparison and failed-evaluation recovery |
| Proctored AI | User-granted camera/mic/entire-screen/fullscreen, own conversation visible, scores/coaching hidden until completion, three browser warnings end session |
| Reports | Saved answers, four rubrics, strengths/gaps/next plan, pending excluded, seven coaching actions and regeneration |
| AI assessments | Topic/JD blueprint, MCQ/written/mixed, max 50 questions, 5–180 min, explicit start and server deadline |
| Runner/results | Map/review flags, serialized autosave, resume, expired submission uses saved answers, immutable submission, MCQ and AI partial-credit written grading, retry evaluation |
| Practice | Six categories × five levels, authored questions, server-enforced 70% unlock and history |
| Assigned tests | Officer authoring, hashed six-digit code, cohort/window checks, one submission, identity snapshot and officer CSV results |
| Calendar/notices | Personal and officer-cohort events, Kolkata week boundaries, list/week/ICS, per-student broadcast read receipts |

## Observation Haki research and drive intake

- `POST /student/conversations` accepts `driveId`: the thread is titled `Eligibility · {company}` and every message builds the job description on the server from the published drive plus the official eligibility result. The student's latest resume is used when none is supplied; without one the assistant asks for it and no AI call is made.
- `POST /student/conversations/:id/message` accepts `webSearch`. Results come from official search APIs only; the model cites result indexes and the server builds `sources`. See [WEB_SEARCH.md](WEB_SEARCH.md).
- `GET /student/career/reports` lists the student's career reports; `GET /student/career/reports/:id` returns one owned report.
- `POST /placement/drives/parse` (placement officers): `{ filename, data }` with a base64 PDF of at most 10 MB returns suggested drive fields, `missingFields` and `warnings`. Nothing is saved to drives; officers review the prefilled form and save it themselves. Extracted text and metadata are kept in `placement.drive_intakes` (officers only); the PDF itself is not stored.

## Registration and record ownership

An email must be confirmed by Supabase Auth before official student data is returned. A unique matching contact email, or a confirmed `<USN>@dsu.edu.in` address for an existing USN, permits automatic linking. Duplicate matches and records already claimed by another account require campus review. A typed USN alone never proves record ownership; unmatched submissions are saved as pending without a student membership. Placement officer access is assigned by an operator.

`202610190006_verified_student_link.sql` hardens the legacy enrollment-link function without changing earlier migration checksums. The API uses the verified-identity link function on completion. Apply pending migrations through the protected operator workflow when authorized. Committing migration files does not apply them to the shared database.

## Operating limits

Document extraction runs in a separate, bounded Node process (two concurrent
uploads, 15-second timeout and 256 MB JavaScript heap per child). This contains
native PDF parser crashes so an uploaded document cannot terminate the campus
API. Child processes exclude Node watch dependency reporting and accept only
tagged extraction results, so development watcher IPC cannot become document
content. The HTTP socket idle timeout is 90 seconds; the former 10-second
limit cut off model replies and extraction before their own deadlines.
Haki reports connection/configuration failures with reconnect and message
retry controls; its web transport allows time for sequential research and AI
generation. Ordinary chats include the student's latest saved resume when no
resume context is supplied explicitly.

AI rubric/fit/ATS scores are estimates, not employer decisions or placement probabilities. Confidence is inferred from text; there is no acoustic scoring, biometric identity validation, face recognition, camera recording, extension blocking or claim that browser events prove cheating. Streams stay local. Proctored sessions show the current question and student's own saved answer text, while withholding scores, original feedback, coaching and future/private question guidance until completion. This is preparation software, not a tamper-proof examination platform.

Interview speech recognition runs locally in a browser worker using the pinned
Whisper tiny.en model and same-origin WASM/model files. No interview audio goes
to a transcription service or the backend; only answer text is evaluated by the
configured OpenRouter provider. Four local voice styles use installed offline
English voices. Preflight includes model preparation, microphone checks and
voice preview. Mock supports typed fallback; proctored requires local speech,
offline voice and media/fullscreen permissions. Rehearse on deployed HTTPS.
Other workspace browser-speech features retain their existing behavior.
Raw files are not retained; extracted text is private. Scanned/locked PDFs need
pasted text.

Interview planning, evaluation and post-session coaching have separate prompts
in `interview-prompts.js`. Follow-up evaluations include the parent answer.
Server checks exclude non-answer turns from scores, align quality labels and
STAR omissions with the evaluation, reject duplicate plan questions and derive
section counts from actual questions. Pending evaluations run one answer per
request so multiple provider calls cannot exceed one transport deadline.

Only placement officers author assigned tests; no faculty role was added. Practice banks are learning content, not claimed university papers. Calendars contain actual published/personal records. Career cards do not pretend to search live jobs. Support points to the campus office, without invented ticket systems or contact details. Bounded recent history and retention policy are documented in ARCHITECTURE.md.

## Dedicated interview workspace (21 October 2026)

Interview configuration accepts optional `preferredMode` (`mock` or `proctored`) and `channels` (`text`, `voice`, `video` booleans). Existing configurations remain valid. At least one answer channel must be enabled; explicit proctored preferences require voice and camera. The final session consent and server session rules still govern starting an interview. These fields do not enable media recording.

`GET /student/interview-sessions` accepts `search` (up to 100 characters), `status` (`all`, `active`, `completed`, `terminated`) and `page` (1–200). It returns `{ rows, page, hasMore }`, with up to 24 owned sessions per page, newest first. Search uses literal title matching. Authentication, linked-student access and the existing restricted actor transaction apply.

`GET /student/interviews/stats` aggregates the existing statistics in one SQL snapshot, replacing eight sequential data reads. Results remain actor-scoped and are not shared between users. The frontend loads each workspace screen separately and defers local speech preparation until needed; this does not itself distribute backend compute.

Interview planning uses a 60-second provider deadline and an 85-second web transport deadline, below the API's 90-second socket limit. DeepSeek V4 planning, Haki chat/JD comparison and interview evaluation/coaching use low reasoning effort to bound conversational waits. Full schemas, scoring rubrics and output budgets remain enforced; assessment generation settings are unchanged. Larger plans have a larger output budget. The configured model, key and ordered provider allowlist stay in use. Timeout, malformed response and truncated output produce distinct deliberate errors; no incomplete plan is saved. Diagnostic logs contain only stage/status/code/timing, never prompts, files, answers, credentials or raw upstream error text.

Keep the selected model and endpoint allowlist compatible. To share Friday's configuration, align both `OPENROUTER_MODEL` and `OPENROUTER_PROVIDER`; leave `STUDENT_AI_MODEL` empty unless intentionally overriding it. Changing only the model can cause provider-routing rejection even with a valid key. Restart the backend after changing its environment. Provider routing/credentials/credit/capacity failures now produce separate safe guidance without exposing raw upstream error bodies.
