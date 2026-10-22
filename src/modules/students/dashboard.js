import { runStudent } from "./context.js";

export function activityStreak(
  dates,
  today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  ),
) {
  const day = (value) =>
    Math.floor(Date.parse(value + "T00:00:00Z") / 86400000);
  const days = [...new Set(dates.map(day))].sort((a, b) => b - a);
  let best = 0,
    current = 0,
    chain = 0,
    previous;
  for (const value of days) {
    chain = previous === value + 1 ? chain + 1 : 1;
    best = Math.max(best, chain);
    previous = value;
  }
  const end = days[0] === day(today) ? day(today) : day(today) - 1;
  for (let value = end; days.includes(value); value--) current++;
  return { current, best };
}
export async function dashboardData(client, official, actor) {
  // One database round trip and one consistent snapshot, inside the existing
  // actor transaction. Never cache private student data across requests.
  const { profile, interviews, sessions, latestSession, resume, attempts, activity, pipeline, schedule, deadlines, applications, notifications } = (
    await client.query(
      `SELECT (SELECT to_jsonb(row) FROM (SELECT details,onboarded FROM student.profiles WHERE user_id=$1) row) AS "profile",
      (SELECT to_jsonb(row) FROM (SELECT count(*)::int plans FROM student.interviews WHERE user_id=$1 AND NOT archived) row) AS "interviews",
      (SELECT to_jsonb(row) FROM (SELECT count(*) FILTER(WHERE status='completed')::int completed,
    avg((report->'scores'->>'overall')::numeric) FILTER(WHERE status='completed') overall,
    avg((report->'scores'->>'communication')::numeric) FILTER(WHERE status='completed') communication,
    avg((report->'scores'->>'accuracy')::numeric) FILTER(WHERE status='completed') accuracy,
    avg((report->'scores'->>'confidence')::numeric) FILTER(WHERE status='completed') confidence
    FROM student.interview_sessions WHERE user_id=$1) row) AS "sessions",
      (SELECT to_jsonb(row) FROM (SELECT id,report,ended_at FROM student.interview_sessions WHERE user_id=$1 AND status='completed' ORDER BY ended_at DESC LIMIT 1) row) AS "latestSession",
      (SELECT to_jsonb(row) FROM (SELECT id,created_at FROM student.reports WHERE user_id=$1 AND kind='career' ORDER BY created_at DESC LIMIT 1) row) AS "resume",
      (SELECT to_jsonb(row) FROM (SELECT count(*)::int completed FROM student.attempts WHERE user_id=$1 AND status='completed') row) AS "attempts",
      (SELECT coalesce(jsonb_agg(row), '[]'::jsonb) FROM (SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,count(*)::int AS count FROM student.activity WHERE user_id=$1 AND kind IN ('interview.completed','assessment.completed','resume.analyzed') AND created_at>now()-interval '1 year' GROUP BY 1 ORDER BY 1 DESC) row) AS "activity",
      (SELECT to_jsonb(row) FROM (SELECT count(*) FILTER(WHERE status='registered')::int registered,count(*) FILTER(WHERE status='in-progress')::int in_progress,count(*) FILTER(WHERE status='selected')::int selected,count(*) FILTER(WHERE status='placed')::int placed,count(*) FILTER(WHERE status='rejected')::int rejected,count(*)::int total FROM placement.registrations WHERE student_id=$2) row) AS "pipeline",
      (SELECT coalesce(jsonb_agg(row), '[]'::jsonb) FROM (SELECT id,title,kind,starts_at,ends_at,location FROM student.calendar_events WHERE starts_at>=now() AND starts_at<now()+interval '48 hours' ORDER BY starts_at LIMIT 12) row) AS "schedule",
      (SELECT coalesce(jsonb_agg(row), '[]'::jsonb) FROM (SELECT d.id,d.title,c.name company,d.registration_deadline::text AS registration_deadline FROM placement.drives d JOIN placement.companies c ON c.id=d.company_id WHERE d.status IN ('upcoming','ongoing') AND d.registration_deadline>=(now() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY d.registration_deadline LIMIT 8) row) AS "deadlines",
      (SELECT coalesce(jsonb_agg(row), '[]'::jsonb) FROM (SELECT r.id,r.status,r.current_round,d.title,c.name company,d.id drive_id FROM placement.registrations r JOIN placement.drives d ON d.id=r.drive_id JOIN placement.companies c ON c.id=d.company_id WHERE r.student_id=$2 ORDER BY r.created_at DESC LIMIT 20) row) AS "applications",
      (SELECT coalesce(jsonb_agg(row), '[]'::jsonb) FROM (SELECT * FROM (SELECT id,title,body,href,read_at,created_at FROM student.notifications WHERE user_id=$1 UNION ALL SELECT b.id,b.title,b.body,b.href,r.read_at,b.created_at FROM student.broadcasts b LEFT JOIN student.notice_reads r ON r.broadcast_id=b.id AND r.user_id=$1) notices ORDER BY created_at DESC LIMIT 8) row) AS "notifications"`,
      [actor, official.id],
    )
  ).rows[0];
  const dates = activity.map((row) => row.day);
  const score =
    sessions.overall === null
      ? null
      : Math.round(Number(sessions.overall) * 10);
  const skills = Object.fromEntries(
    ["communication", "accuracy", "confidence", "overall"].map((key) => [
      key,
      sessions[key] == null ? null : Math.round(Number(sessions[key]) * 10),
    ]),
  );
  const next = !profile?.onboarded
    ? {
        title: "Make your workspace yours",
        reason: "Set your goals and preparation preferences.",
        href: "/student/onboarding",
        label: "Complete setup",
      }
    : !resume
      ? {
          title: "Give your experience a voice",
          reason: "A resume report helps identify evidence and practical gaps.",
          href: "/student/resume/intake",
          label: "Add your resume",
        }
      : !sessions.completed
        ? {
            title: "Start with one conversation",
            reason:
              "Your first completed interview creates a measured preparation baseline.",
            href: "/student/interview",
            label: "Create an interview",
          }
        : {
            title: "Build on your last interview",
            reason: "Review your latest coaching before another attempt.",
            href: "/student/readiness",
            label: "Review next steps",
          };
  return {
    official,
    profile: profile?.details || {},
    onboarded: !!profile?.onboarded,
    score,
    band:
      score === null
        ? "Not measured"
        : score >= 75
          ? "Interview ready"
          : score >= 50
            ? "On track"
            : "Building",
    basis:
      "Average AI rubric scores from completed interviews. This is preparation guidance, not an official placement decision.",
    skills,
    sessions: Number(sessions.completed),
    plans: interviews.plans,
    assessments: attempts.completed,
    resume,
    latestSession,
    streak: activityStreak(dates),
    activityDates: dates.slice(0, 30),
    activity: activity.slice(0, 30),
    pipeline: {
      registered: pipeline.registered,
      inProgress: pipeline.in_progress,
      selected: pipeline.selected,
      placed: pipeline.placed,
      rejected: pipeline.rejected,
      total: pipeline.total,
    },
    schedule,
    deadlines,
    applications,
    notifications,
    next,
    academicEligibility:
      official.cgpa === null ? null : Number(official.cgpa) >= 6.75,
  };
}
export function registerDashboardRoutes(api, { pool }) {
  for (const resource of ["dashboard", "readiness"])
    api.get(`/student/${resource}`, async (req) =>
      runStudent(pool, req.actor.id, async (client, official) => ({
        data: await dashboardData(client, official, req.actor.id),
      })),
    );
}
