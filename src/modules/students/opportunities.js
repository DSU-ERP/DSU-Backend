import { z } from "zod";
import { runStudent, activity } from "./context.js";
import { compareDecimal, validCgpa } from "../analytics/categoryRules.js";
import { httpError } from "../../platform/http/errors.js";
const rank = (value) =>
  Number(value) <= 5
    ? 1
    : Number(value) <= 10
      ? 2
      : Number(value) <= 15
        ? 3
        : 4;
// SQL dates are selected as YYYY-MM-DD text. A Date object (other drivers)
// is read in campus time so the comparison never uses "Sat Oct 10 ..." text.
const dateText = (value) =>
  value instanceof Date
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(value)
    : String(value).slice(0, 10);
export function opportunityEligibility(
  student,
  drive,
  highestRank = 0,
  today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  ),
) {
  const gaps = [];
  if (!validCgpa(student.cgpa) || student.current_backlog === null)
    gaps.push("Academic evidence is incomplete.");
  else {
    if (compareDecimal(student.cgpa, String(drive.min_cgpa)) < 0)
      gaps.push(`Requires CGPA ${drive.min_cgpa} or above.`);
    if (student.current_backlog > drive.max_backlogs)
      gaps.push(`Allows at most ${drive.max_backlogs} current backlogs.`);
    if (
      drive.min_attendance !== null &&
      drive.min_attendance !== undefined &&
      (student.attendance === null ||
        student.attendance === undefined ||
        !(Number(student.attendance) >= Number(drive.min_attendance)))
    )
      gaps.push(`Requires attendance of ${Number(drive.min_attendance)}% or above.`);
  }
  if (
    drive.branches.length &&
    !drive.branches.includes(student.department_short_name)
  )
    gaps.push("Your branch is outside this drive’s permitted branches.");
  if (highestRank >= rank(drive.package_lpa))
    gaps.push(
      "A new placement must be in a higher package category than your active offer.",
    );
  if (!drive.published || !["upcoming", "ongoing"].includes(drive.status))
    gaps.push("Registration is not open.");
  if (drive.registration_deadline && dateText(drive.registration_deadline) < today)
    gaps.push("The registration deadline has passed.");
  return {
    eligible: gaps.length === 0,
    gaps,
    basis:
      "Official university academics, drive criteria, deadline and active offers. AI advice does not change this decision.",
  };
}
export async function highestRank(client, studentId) {
  return Number(
    (
      await client.query(
        "SELECT coalesce(max(CASE WHEN o.package_lpa<=5 THEN 1 WHEN o.package_lpa<=10 THEN 2 WHEN o.package_lpa<=15 THEN 3 ELSE 4 END),0) rank FROM placement.offers o JOIN placement.registrations r ON r.id=o.registration_id WHERE r.student_id=$1 AND o.status IN ('offered','accepted')",
        [studentId],
      )
    ).rows[0].rank,
  );
}
export async function driveRecord(client, id) {
  const { rows } = await client.query(
    "SELECT d.*,d.drive_date::text AS drive_date,d.registration_deadline::text AS registration_deadline,c.name company FROM placement.drives d JOIN placement.companies c ON c.id=d.company_id WHERE d.id=$1",
    [id],
  );
  if (!rows[0])
    throw httpError(404, "NOT_FOUND", "This opportunity is not available.");
  return rows[0];
}

const packageCategory = (lpa) =>
  lpa === null ? null : lpa <= 5 ? "regular" : lpa <= 10 ? "dream" : lpa <= 15 ? "super-dream" : "mega";
// Counts behind a student's recruitment track record (shown to the student).
export function placementSummary(record) {
  const registrations = record?.registrations || [],
    offers = record?.offers || [];
  const results = registrations.flatMap((item) => item.results || []);
  const active = offers.filter((offer) => ["offered", "accepted"].includes(offer.status));
  const highest = active.length
    ? Math.max(...active.map((offer) => Number(offer.package_lpa)))
    : null;
  return {
    applied: registrations.length,
    interviews: registrations.filter((item) =>
      (item.results || []).some((result) => result.result !== "absent"),
    ).length,
    roundsAttended: results.filter((result) => result.result !== "absent").length,
    roundsCleared: results.filter((result) => result.result === "pass").length,
    absences: results.filter((result) => result.result === "absent").length,
    inProgress: registrations.filter((item) => ["registered", "in-progress"].includes(item.status)).length,
    selected: registrations.filter((item) => ["selected", "placed"].includes(item.status)).length,
    offers: offers.length,
    activeOffers: active.length,
    accepted: offers.filter((offer) => offer.status === "accepted").length,
    highestPackage: highest,
    highestCategory: packageCategory(highest),
  };
}
export function registerOpportunityRoutes(api, { pool }) {
  api.get("/student/placement-record", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      const record = (await client.query("SELECT student.placement_record() AS data")).rows[0]
        .data || { registrations: [], offers: [] };
      return { data: { ...record, summary: placementSummary(record) } };
    }),
  );
  api.get("/student/opportunities", async (req) => {
    const q = z
      .object({
        search: z.string().max(100).default(""),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .strict()
      .parse(req.query);
    return runStudent(pool, req.actor.id, async (client, official) => {
      const query =
        "FROM placement.drives d JOIN placement.companies c ON c.id=d.company_id WHERE strpos(lower(c.name||' '||d.title||' '||d.description||' '||d.skills||' '||coalesce(d.location,'')),lower($1))>0";
      const total = Number(
        (await client.query("SELECT count(*)::int total " + query, [q.search]))
          .rows[0].total,
      );
      const rows = (
        await client.query(
          "SELECT d.*,d.drive_date::text AS drive_date,d.registration_deadline::text AS registration_deadline,c.name company " +
            query +
            " ORDER BY d.created_at DESC,d.id LIMIT 24 OFFSET $2",
          [q.search, (q.page - 1) * 24],
        )
      ).rows;
      const highest = await highestRank(client, official.id);
      const applications = (
        await client.query(
          "SELECT drive_id,status,current_round FROM placement.registrations WHERE student_id=$1",
          [official.id],
        )
      ).rows;
      return {
        data: {
          rows: rows.map((drive) => ({
            ...drive,
            eligibility: opportunityEligibility(official, drive, highest),
            application:
              applications.find((item) => item.drive_id === drive.id) || null,
          })),
          total,
          page: q.page,
          limit: 24,
        },
      };
    });
  });
  api.get("/student/opportunities/:id", async (req) => {
    const id = z.uuid().parse(req.params.id);
    return runStudent(pool, req.actor.id, async (client, official) => {
      const drive = await driveRecord(client, id),
        highest = await highestRank(client, official.id);
      const application =
        (
          await client.query(
            "SELECT id,status,current_round FROM placement.registrations WHERE drive_id=$1 AND student_id=$2",
            [id, official.id],
          )
        ).rows[0] || null;
      return {
        data: {
          ...drive,
          eligibility: opportunityEligibility(official, drive, highest),
          application,
        },
      };
    });
  });
  api.post("/student/opportunities/:id/apply", async (req) => {
    const id = z.uuid().parse(req.params.id);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client, official) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('placement.write'))",
      );
      const drive = await driveRecord(client, id),
        eligibility = opportunityEligibility(
          official,
          drive,
          await highestRank(client, official.id),
        );
      if (!eligibility.eligible)
        throw httpError(409, "NOT_ELIGIBLE", eligibility.gaps.join(" "));
      await client.query(
        "INSERT INTO placement.interests(drive_id,student_id,state,recorded_by) VALUES($1,$2,'interested',$3) ON CONFLICT(drive_id,student_id) DO UPDATE SET state='interested',recorded_by=$3,recorded_at=now()",
        [id, official.id, req.actor.id],
      );
      const { rows } = await client.query(
        "INSERT INTO placement.registrations(drive_id,student_id) VALUES($1,$2) ON CONFLICT(drive_id,student_id) DO NOTHING RETURNING id,status",
        [id, official.id],
      );
      await activity(client, req.actor.id, "placement.applied", id);
      return { data: rows[0] || { alreadyApplied: true } };
    });
  });
  api.post("/student/opportunities/:id/withdraw", async (req) => {
    const id = z.uuid().parse(req.params.id);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client, official) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('placement.write'))",
      );
      const { rows } = await client.query(
        "UPDATE placement.registrations SET status='withdrawn',revision=revision+1,updated_at=now() WHERE drive_id=$1 AND student_id=$2 AND status IN ('registered','in-progress','selected') AND NOT EXISTS(SELECT 1 FROM placement.offers o WHERE o.registration_id=placement.registrations.id AND o.status IN ('offered','accepted')) RETURNING id,status",
        [id, official.id],
      );
      if (!rows[0])
        throw httpError(
          409,
          "WITHDRAWAL_UNAVAILABLE",
          "Only an active application without an offer can be withdrawn.",
        );
      await activity(client, req.actor.id, "placement.withdrawn", id);
      return { data: rows[0] };
    });
  });
}
