// "Your placement and schedule" context for the student FRIDAY. Every query
// runs inside the student's own transaction, so row-level security limits it
// to drives published to this student, their own applications, their calendar
// and their notices. Nothing about other students or officer work is read.

import { PLACEMENT_POLICY } from "../analytics/placementPolicy.js";

export const SCHEDULE_REQUEST =
  /\b(?:schedule[ds]?|calendar|today|tomorrow|this week|next week|upcoming|deadlines?|due|drives?|interviews?|rounds?|tests?|exams?|assessments?|work|tasks?|to-?dos?|pending|notifications?|notices?|apply|applied|applications?|compan(?:y|ies)|offers?|selected|placements?|recruit\w*|hiring|package|ctc|stipend|bond|role|jobs?|internships?)\b/i;

export const PLACEMENT_SCOPE_RULES = `myPlacement holds only this student's own placement and schedule data: drives the placement office published to them (with company details and what is offered), their applications and round results, calendar events and assessments in the next 14 days, and unread notices. Use it to answer questions about their schedule, deadlines, drives, companies, offers and pending work, quoting dates exactly. When myPlacement.detail is "summary", it holds counts only; say what is coming up and invite a more specific question. Never reveal or speculate about other students, applicant counts, shortlists, how a drive's audience was chosen, placement-office decisions that are not shown, or company-internal information. Decline requests that are not about the student's own studies, career or placement (for example placement-office operations, another student's records, company review decisions, or unrelated topics) in one sentence, and say what you can help with instead. Never write internal field names such as myPlacement in an answer; say "your placement record" or "your drives" instead.`;

// The institution's placement rule, from the same policy the officer portal
// uses, so student and officer answers agree.
export const ELIGIBILITY_RULES = `Institution placement rule: a student is placement-eligible with a valid official CGPA of ${PLACEMENT_POLICY.minimumCgpa} or above on the 10-point scale; backlogs and attendance are not part of this rule. When the student asks what a CGPA means for placement eligibility, state this rule first and compare their CGPA with ${PLACEMENT_POLICY.minimumCgpa}, then add that individual companies may set higher cutoffs and that the placement office makes the official decision.`;

const day = (offsetDays, now) => new Date(now.getTime() + offsetDays * 86400000).toISOString();

export async function studentPlacementContext(client, actor, message, now = new Date()) {
  const detailed = SCHEDULE_REQUEST.test(message);
  const drives = (
    await client.query(
      `SELECT d.id,d.title,c.name AS company,c.industry,c.website,left(coalesce(c.about,''),400) AS about,d.employment_type,d.job_category,
        d.package_lpa::text,d.ctc_fixed_lpa::text,d.ctc_variable_lpa::text,d.stipend_monthly::text,d.internship_months,d.bond_months,
        d.bond_details,d.work_mode,d.joining_date::text,d.location,d.openings,d.rounds,left(d.skills,300) AS skills,
        d.drive_date::text,d.registration_deadline::text,d.status,
        (SELECT r.status FROM placement.registrations r WHERE r.drive_id=d.id AND r.student_id=erp.actor_student()) AS my_application
       FROM placement.drives d JOIN placement.companies c ON c.id=d.company_id
       WHERE d.status IN ('upcoming','ongoing')
       ORDER BY coalesce(d.registration_deadline,d.drive_date) NULLS LAST,d.id LIMIT 15`,
    )
  ).rows;
  const record =
    (await client.query("SELECT student.placement_record() AS data")).rows[0]?.data || { registrations: [], offers: [] };
  const events = (
    await client.query(
      `SELECT title,kind,starts_at,ends_at,location FROM student.calendar_events
       WHERE starts_at>=$1 AND starts_at<$2 ORDER BY starts_at LIMIT 20`,
      [day(0, now), day(14, now)],
    )
  ).rows;
  const assessments = (
    await client.query(
      `SELECT a.title,a.opens_at,a.closes_at FROM student.assessments a
       WHERE a.kind='assigned' AND a.published AND (a.closes_at IS NULL OR a.closes_at>$1) AND (a.opens_at IS NULL OR a.opens_at<$2)
         AND NOT EXISTS(SELECT 1 FROM student.attempts t WHERE t.assessment_id=a.id AND t.user_id=$3 AND t.status IN ('submitted','completed'))
       ORDER BY a.closes_at NULLS LAST LIMIT 10`,
      [now.toISOString(), day(14, now), actor],
    )
  ).rows;
  const notices = (
    await client.query(
      `SELECT title,created_at FROM (
         SELECT title,created_at FROM student.notifications WHERE user_id=$1 AND read_at IS NULL
         UNION ALL SELECT b.title,b.created_at FROM student.broadcasts b
           WHERE NOT EXISTS(SELECT 1 FROM student.notice_reads r WHERE r.broadcast_id=b.id AND r.user_id=$1)) n
       ORDER BY created_at DESC LIMIT 10`,
      [actor],
    )
  ).rows;
  const active = (record.registrations || []).filter((r) => ["registered", "in-progress", "selected"].includes(r.status));
  if (!detailed)
    return {
      detail: "summary",
      openDrives: drives.length,
      openDrivesNotApplied: drives.filter((d) => !d.my_application).length,
      nextDeadline: drives.map((d) => d.registration_deadline).filter(Boolean).sort()[0] || null,
      activeApplications: active.length,
      eventsNext14Days: events.length,
      openAssessments: assessments.length,
      unreadNotices: notices.length,
    };
  return {
    detail: "full",
    drives,
    applications: (record.registrations || []).slice(0, 20).map((r) => ({
      company: r.company,
      title: r.title,
      status: r.status,
      currentRound: r.current_round,
      rounds: r.rounds,
      driveDate: r.drive_date,
      results: r.results,
    })),
    offers: (record.offers || []).slice(0, 10).map((o) => ({ company: o.company, title: o.title, packageLpa: o.package_lpa, status: o.status })),
    events,
    assessments,
    notices,
  };
}
