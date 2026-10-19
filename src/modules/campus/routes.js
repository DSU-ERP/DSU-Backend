import { Readable } from 'node:stream';
import { z } from 'zod';
import { withActor } from '../../integrations/supabase/db.js';
import { httpError } from '../../platform/http/errors.js';
import { importStudents } from '../imports/importer.js';
import { registerAnalytics } from '../analytics/studentAnalytics.js';
import { categorySql, categoryDefinition } from '../analytics/categoryRules.js';
export function registerCampusRoutes(api, { pool }) {
  const run = (req, allowed, fn, options) =>
    withActor(
      pool,
      req.actor.id,
      async (client) => {
        const { rows } = await client.query(
          "SELECT role, student_id FROM erp.memberships WHERE user_id=$1",
          [req.actor.id],
        );
        const membership = rows[0];
        if (!membership || (allowed && !allowed.includes(membership.role)))
          throw httpError(
            403,
            "FORBIDDEN",
            "Your account does not have access to this resource.",
          );
        return fn(client, membership);
      },
      options,
    );
  const audit = (client, req, action, resource = null) =>
    client.query(
      "INSERT INTO erp.audit_events(actor_id,action,resource_id) VALUES ($1,$2,$3)",
      [req.actor.id, action, resource],
    );
  const runImport = (req, fn) => withActor(pool, req.actor.id, async client => {
    const {rows}=await client.query("SELECT erp.can_import_students() AS allowed");
    if(rows[0]?.allowed!==true)throw httpError(403,"FORBIDDEN","Placement Officer or administrator access is required.");
    await client.query("SELECT set_config('app.student_import', 'true', true)");
    return fn(client);
  });
  registerAnalytics(api, { run, audit, httpError });
  api.get("/me", async (req) =>
    run(req, null, async (_client, m) => ({
      data: { id: req.actor.id, role: m.role, studentId: m.student_id },
    })),
  );
  api.get("/overview", async (req) =>
    run(req, ["admin", "staff"], async (client) => {
      const totals = await client.query(
        "SELECT count(*)::int AS students,count(DISTINCT department_short_name)::int AS departments,count(DISTINCT source_batch)::int AS batches FROM erp.students",
      );
      const departments = await client.query(
        "SELECT department_short_name AS name,count(*)::int AS students FROM erp.students GROUP BY 1 ORDER BY 2 DESC",
      );
      await audit(client, req, "overview.read");
      return {
        data: { ...totals.rows[0], departmentBreakdown: departments.rows },
      };
    }),
  );
  api.get("/students", async (req) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        search: z.string().trim().max(100).default(""),
        batch: z
          .string()
          .regex(/^20\d{2}$/)
          .optional(),
      })
      .strict()
      .parse(req.query);
    return run(req, ["admin", "staff"], async (client) => {
      // Prefix search, escaped LIKE characters; never interpolate user input.
      const search = q.search.replace(/[\\%_]/g, "\\$&") + "%";
      const params = [search, q.batch || null];
      const where =
        "(s.full_name ILIKE $1 OR s.enrollment_no ILIKE $1) AND ($2::text IS NULL OR s.source_batch=$2)";
      const total = await client.query(
        `SELECT count(*)::int AS count FROM erp.students s WHERE ${where}`,
        params,
      );
      const classification = categorySql("a.cgpa", (value) => {
        params.push(value);
        return `$${params.length}`;
      });
      const rows = await client.query(
        `SELECT s.id,s.enrollment_no,s.full_name,s.department_short_name,s.source_batch,s.current_semester,s.status,a.cgpa,a.attendance,${classification} AS category_id FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id WHERE ${where} ORDER BY s.enrollment_no LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, (q.page - 1) * q.limit],
      );
      await audit(client, req, "students.list");
      return {
        data: rows.rows.map((student) => ({
          ...student,
          category: categoryDefinition(student.category_id),
        })),
        pagination: {
          page: q.page,
          limit: q.limit,
          total: total.rows[0].count,
        },
      };
    });
  });
  api.get("/students/:id", async (req) => {
    const id = z.uuid().parse(req.params.id);
    return run(req, null, async (client, m) => {
      const result = await client.query(
        "SELECT id,enrollment_no,full_name,display_no,course_name,department_name,current_semester,current_batch,current_division,status,source_batch FROM erp.students WHERE id=$1",
        [id],
      );
      if (!result.rows[0])
        throw httpError(404, "NOT_FOUND", "Student record not found.");
      const academic = await client.query(
        "SELECT attendance,achievements,cgpa,percentage,sgpa,current_backlog,total_backlog FROM erp.academics WHERE student_id=$1",
        [id],
      );
      let contact = null,
        fees = null;
      if (m.role !== "staff") {
        contact =
          (
            await client.query(
              "SELECT details FROM erp.contacts WHERE student_id=$1",
              [id],
            )
          ).rows[0]?.details || null;
        fees =
          (
            await client.query(
              "SELECT fees_paid,fees_outstanding,fee_category FROM erp.academics WHERE student_id=$1",
              [id],
            )
          ).rows[0] || null;
      }
      await audit(client, req, "student.read", id);
      return {
        data: {
          ...result.rows[0],
          academic: academic.rows[0] || null,
          contact,
          fees,
        },
      };
    });
  });
  api.get("/imports", async (req) =>
    runImport(req, async (client) => ({
      data: (
        await client.query(
          "SELECT id,source_batch,summary,created_at FROM erp.import_runs ORDER BY created_at DESC LIMIT 20",
        )
      ).rows,
    })),
  );
  api.post(
    "/imports",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const { batch } = z
        .object({ batch: z.string().regex(/^20\d{2}$/) })
        .strict()
        .parse(req.query);
      if (
        typeof req.body !== "string" ||
        !req.headers["content-type"]?.startsWith("text/csv")
      )
        throw httpError(415, "INVALID_CONTENT_TYPE", "Upload a CSV file.");
      return runImport(req, async (client) => {
        try {
          return {
            data: await importStudents(
              client,
              Readable.from([req.body]),
              batch,
              req.actor.id,
            ),
          };
        } catch (e) {
          if (e.code) throw e;
          throw httpError(
            400,
            "INVALID_CSV",
            "CSV structure is invalid; no changes were saved.",
          );
        }
      });
    },
  );
}
