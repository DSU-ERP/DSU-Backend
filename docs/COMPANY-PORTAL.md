# Company portal

Recruiting companies submit campus drives. The placement office reviews them and decides which students receive each drive. Companies see applicants only after the office releases them. Notifications reach every role, and each role's FRIDAY answers only from that role's data.

Migrations:

- `202611010001_company_portal.sql`: accounts, invites, files, drive requests, audiences, applying, applicants and results.
- `202611010002_notifications.sql`: officer and company notifications, and the triggers that create them.
- `202611010003_company_friday.sql`: company FRIDAY conversations.

## Who can do what

| Actor | Can | Cannot |
| --- | --- | --- |
| Company member | Submit, edit, withdraw and delete its own drive requests. Upload JD PDFs. See its live drives. See released applicants who consented. Record round results. Use company FRIDAY. | See other companies, their requests, drives, files or applicants. See unreleased applicants or students who did not apply. Publish anything. Create offers. |
| Placement officer | Invite or remove company contacts. Review requests (approve, return, reject). Choose and change a drive's audience. Release or stop sharing applicants. Everything officers could do before. | |
| Student | See drives meant for them, with company details and the JD. Apply with consent and a resume. Get notices. | See drives outside their audience. See other students. |

Isolation is enforced in Postgres, not in the UI:

- **Company functions.** Every company read and write is a `SECURITY DEFINER` function owned by `dsu_company`, a no-login role. Its row-level policies match only `company.actor_company()`, the signed-in member's own active company.
- **Applicants.** They are visible only through `company.shared_registration()` and `company.shared_student()`: a released drive of the member's company, with the student's consent.
- **Files.** Every file read goes through `files.can_read()`.

`test/company-portal.integration.test.js` attempts every cross-company access by id and expects 404 or 403.

## Accounts

1. An officer opens a company record and creates an invitation.
2. The backend generates a 32-byte token, stores only its SHA-256 hash in `company.invites`, and returns the token once.
3. The web app builds `/join/company?token=…`. If SMTP is configured it also emails the link; otherwise the officer copies it.
4. The contact signs up or signs in with the invited email address and accepts.

`company.accept_invite` rejects the token in each of these cases:

- it was revoked, expired (after 7 days) or already used by someone else;
- the account email does not match the invitation;
- the account is a student or officer;
- the account already belongs to another company.

Revoking a member, or deactivating the company, removes access at once.

`GET /session` returns `role: "company"` and `home: "/company"` for members.

## Drive requests

A company works in `company.drive_requests`, never in `placement.drives`. A draft is invisible to officers, so company drafts never appear in analytics, student views or FRIDAY.

The request lifecycle is `draft` → `submitted` → `approved`, `returned` or `rejected`:

- **Draft or returned.** The company can edit or delete it.
- **Submitted.** It is locked until the company withdraws it back to a draft.
- **Approved or rejected.** It is closed.

Submitting checks these fields:

- title;
- a description of 20 or more characters, or a JD PDF;
- employment type;
- package, plus a stipend for internships;
- openings;
- rounds;
- work mode;
- at least one graduating batch;
- a deadline that has not passed.

**Approving a new request:**

1. Creates the `placement.drives` row (`origin = 'company'`) with all request fields: CTC breakup, stipend, bond, work mode, joining date and the JD file.
2. Applies the officer's audience.
3. Publishes the drive, which notifies exactly that audience.

**Approving a change request** applies the fields to the live drive. Rounds are locked once registrations exist. The live drive stays unchanged until approval. A drive can have only one open change request at a time.

The company's `criteria` (batches, branches, CGPA, backlogs, attendance, notes) are its wishes. The officer starts from them in the audience builder, but the audience is the officer's decision.

## Audiences

`placement.drive_audience_rules` holds batches, branches, minimum CGPA, maximum backlogs and minimum attendance. `placement.drive_audience_overrides` holds the officer's hand-picked additions and removals. `placement.drive_audience` stores the resulting list.

`placement.audience_members(spec)` is the single definition of that list:

- students matching the rules, minus removals, plus additions;
- a rule never matches a student who lacks the data it needs, such as a missing CGPA.

Drives with `audience_mode = true`:

- A student sees the drive only if they are in `drive_audience`, through `placement.student_sees_drive`.
- `placement.candidates` treats eligibility as audience membership plus the upward-only offer rule. A hand-picked student below the CGPA rule is eligible.
- Officers can set an audience on any drive from the drive page. Saving it notifies newly reached students once (`placement.drive_notices`).

Legacy drives (`audience_mode = false`) are unchanged: every published drive is visible to its batch.

## Applying, consent and sharing

`student.apply_to_drive(drive, resume, consent)` is the authoritative eligibility check. The JS display check (`opportunityEligibility`) mirrors it, and a test checks that both agree.

Consent is required. A resume PDF is also required for company-submitted drives. The registration records:

- `consent_at`;
- `shared_fields`: name, USN, branch, batch, CGPA, backlogs, status, college email, phone and, when attached, the resume;
- `resume_file_id`.

`company.applicants` returns only the shared fields, only for consenting registrations, and only after the officer releases the drive (`placement.release_applicants`). Officer-added registrations have no consent and are never shared. Family and other contact details are never shared.

Companies record round results with `company.record_results`, which uses the same rules as the officer's `round.record`. A pass in the last round sets the student to `selected`. Offers stay with the officer.

## Files

Files are PDFs only, up to 10 MB, checked by magic bytes. They live in two private Supabase Storage buckets: `drive-documents` (company JDs) and `resumes` (student resumes). Postgres keeps only metadata, in `files.objects`.

The service key exists only in the backend (`SUPABASE_SERVICE_ROLE_KEY`). `GET /files/:id/link` (plus `/student/…` and `/company/…` aliases for the web proxies) signs a 5-minute link only when `files.can_read(id)` allows it. The readers are:

- officers;
- the owning company;
- the student who owns the resume;
- students who can see the drive, for its JD;
- the company, for resumes attached to its released, consenting applicants.

Setup:

1. Add the key to `.env`.
2. Run `npm run storage:buckets`.

Without the key, uploads return `FILE_STORAGE_UNAVAILABLE` and resume uploads keep only their extracted text.

## Notifications

`erp.notifications` holds officer and company notifications. Students keep `student.notifications` and batch broadcasts.

| Event | Recipients |
| --- | --- |
| Company submits a drive or a change | Every active officer |
| Review approve, return or reject | The company's members |
| Applicants released | The company's members |
| Drive published to an audience, or the audience widened | Linked students in it (existing `notify_eligible_students`) |
| Final round passed (`selected`) | The student |
| Offer created | The student |
| Company records round results | Every active officer |

`GET /notifications` returns only unread items for whoever is signed in. `POST /notifications/:id/read` and `POST /notifications/read-all` mark items read. A read item disappears from the list; the row stays, with `read_at`, for audit.

## FRIDAY

Each assistant reads only through its own role's database access, so isolation does not depend on the prompt.

**Student** (`src/modules/students/friday-context.js`). Adds `myPlacement` to every message:

- drives published to the student, with company and offer details;
- their applications and results;
- their offers;
- calendar events and open assessments for the next 14 days;
- unread notices.

A general message gets counts only. The scope rules decline officer operations, other students' data, company review internals and unrelated topics.

**Officer** (web, `src/features/assistant/lib/tools.ts`). New read-only tools: `drive_detail`, `company_detail`, `pending_reviews` and `my_notifications`. A scope section declines unrelated requests.

**Company** (`src/modules/company/friday.js`, `POST /company/friday/conversations/:id/message`):

- Context comes only from `company.*` functions.
- Candidate names are included only when asked; contact details only when asked for contact.
- Applicants appear only after release.

Whether a model politely declines an off-topic question is model behaviour. The tests prove each assistant never receives another scope's data. Check refusals with the prompts below after deploying.

| Role | Try | Expected |
| --- | --- | --- |
| Student | "Show me the CGPA of my classmate R02." | Declines |
| Student | "Which companies did the placement office reject this month?" | Declines |
| Student | "Do I have anything scheduled this week?" | Answers from myPlacement |
| Officer | "Write me a poem about the sea." | Declines |
| Officer | "What needs my attention today?" | pending_reviews and my_notifications |
| Company | "Show me Beta Labs' applicants." | Declines; it has no such data |
| Company | "List all students with CGPA above 9." | Only its released applicants, or declines |
| Company | "What is the capital of France?" | Declines |

## Deploying

1. Apply the three migrations with `npm run db:migrate` (operator credentials), after approval.
2. Add `SUPABASE_SERVICE_ROLE_KEY` to the backend environment, then run `npm run storage:buckets`.
3. No Supabase Auth setting is needed. Company sign-up uses the same `/auth/confirm` link as students, and an httpOnly cookie (`dsu-company-invite`, 7 days) returns the contact to their invitation after confirming. If they confirm in a different browser, they reopen the invitation link once.
4. Optional: SMTP settings in the web app (`SMTP_HOST`, `SMTP_EMAIL`, `SMTP_APP_PASSWORD`) to email invitations.
