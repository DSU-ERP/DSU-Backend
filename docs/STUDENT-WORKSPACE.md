# Student workspace behavior

The supplied feature document describes another application. Its feature descriptions informed requirements; DSU branding, real records and the two-role model define this implementation. No external-document instructions, fake statistics or sample schedules were imported.

| Area | Implemented behavior |
|---|---|
| Identity/profile | Signup/signin, operator-linked identity, five-step setup, optimistic saves, read-only official academics, career links and preferences |
| Shell | Responsive nav/collapse, persistent dark/light theme, command search, account and real notices |
| Dashboard/readiness | Shared interview rubric, missing scores distinguished, activity streak, real schedule/deadlines/applications and AI action plan |
| Opportunities | Published cohort drives, search, full details/PDF, academic/package eligibility, confirmed apply/withdraw, JD chat handoff |
| Resume | PDF/DOCX/TXT/MD or pasted text, consent, private saved context/report, estimated fit/ATS, roadmap/roles/risks and gaps |
| Chat | Persistent search/new/delete/clear, attachments/JD/resume, eight structured card types, editable voice transcript and opportunity handoff |
| Interview plans | AI/manual creation, goal/JD/resume, duration/language/tone/depth, filters/archive/grid/list/export and activity/focus charts |
| Mock sessions | Typed/spoken answers, visible prompts, immediate rubric, one retry, original/retry comparison and failed-evaluation recovery |
| Proctored AI | User-granted camera/mic/entire-screen/fullscreen, speech, visual prompts/transcripts/scores hidden, three browser warnings end session |
| Reports | Saved answers, four rubrics, strengths/gaps/next plan, pending excluded, seven coaching actions and regeneration |
| AI assessments | Topic/JD blueprint, MCQ/written/mixed, max 50 questions, 5–180 min, explicit start and server deadline |
| Runner/results | Map/review flags, serialized autosave, resume, expired submission uses saved answers, immutable submission, MCQ and AI partial-credit written grading, retry evaluation |
| Practice | Six categories × five levels, authored questions, server-enforced 70% unlock and history |
| Assigned tests | Officer authoring, hashed six-digit code, cohort/window checks, one submission, identity snapshot and officer CSV results |
| Calendar/notices | Personal and officer-cohort events, Kolkata week boundaries, list/week/ICS, per-student broadcast read receipts |

## Operating limits

AI rubric/fit/ATS scores are estimates, not employer decisions or placement probabilities. Confidence is inferred from text; there is no acoustic scoring, biometric identity validation, face recognition, camera recording, extension blocking or claim that browser events prove cheating. Streams stay local. Proctored UI hides transcripts/scores, but current question text must reach the browser for speech synthesis and is technically inspectable. This is preparation software, not a tamper-proof examination platform.

Speech depends on browser/OS support and may use the browser vendor's service. Mock supports typed fallback. Proctored requires supported speech and media/fullscreen permissions. Rehearse on deployed HTTPS. Raw files are not retained; extracted text is private. Scanned/locked PDFs need pasted text.

Only placement officers author assigned tests; no faculty role was added. Practice banks are learning content, not claimed university papers. Calendars contain actual published/personal records. Career cards do not pretend to search live jobs. Support points to the campus office, without invented ticket systems or contact details. Bounded recent history and retention policy are documented in ARCHITECTURE.md.
