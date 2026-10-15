import { z } from "zod";
import { PLACEMENT_POLICY, placementSql, placementLabel } from './placementPolicy.js';
import {
  CATEGORY_RULES,
  CGPA_SCALE,
  DISTRIBUTION_BANDS,
  categoryDefinition,
  categorySql,
} from "./categoryRules.js";

export const filtersSchema = z.object({
  batch: z
    .string()
    .regex(/^20\d{2}$/)
    .optional(),
  department: z.string().trim().min(1).max(200).optional(),
  search: z.string().trim().max(100).default(""),
});
export const listSchema = filtersSchema
  .extend({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export const categorySchema = z.enum(CATEGORY_RULES.map((rule) => rule.id));

export function cohortQuery(filters) {
  const values = [];
  const bind = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  const category = categorySql("a.cgpa", bind);
  const clauses = [];
  if (filters.batch) clauses.push(`s.source_batch = ${bind(filters.batch)}`);
  if (filters.department === "__missing__")
    clauses.push("s.department_short_name IS NULL");
  else if (filters.department)
    clauses.push(`s.department_short_name = ${bind(filters.department)}`);
  if (filters.search) {
    const search = bind(`%${filters.search.replace(/[\\%_]/g, "\\$&")}%`);
    clauses.push(
      `(s.full_name ILIKE ${search} ESCAPE '\\' OR s.enrollment_no ILIKE ${search} ESCAPE '\\')`,
    );
  }
  // Both join keys are unique in the schema: each selected student appears once.
  const sql = `WITH cohort AS (
    SELECT s.id,s.enrollment_no,s.full_name,s.department_short_name,s.source_batch,
      a.cgpa,${category} AS category_id
    FROM erp.students s LEFT JOIN erp.academics a ON a.student_id=s.id
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
  )`;
  return { sql, values, bind };
}

export async function filterOptions(client) {
  const result = await client.query(`SELECT
    ARRAY(SELECT DISTINCT source_batch FROM erp.students ORDER BY source_batch DESC) AS batches,
    ARRAY(SELECT DISTINCT department_short_name FROM erp.students WHERE department_short_name IS NOT NULL ORDER BY department_short_name) AS departments,
    EXISTS(SELECT 1 FROM erp.students WHERE department_short_name IS NULL) AS missing_department`);
  return result.rows[0];
}

export async function analyticsSummary(client, filters) {
  const q = cohortQuery(filters);
  const categories = CATEGORY_RULES.map((rule) => {
    const id = q.bind(rule.id);
    const eligible = placementSql('cohort.cgpa', q.bind);
    return `jsonb_build_object('id',${id}::text,'count',count(*) FILTER(WHERE category_id=${id}),
      'eligibleCount',count(*) FILTER(WHERE category_id=${id} AND (${eligible}) IS TRUE),
      'averageCgpa',(avg(cgpa) FILTER(WHERE category_id=${id}))::text)`;
  });
  const distribution = DISTRIBUTION_BANDS.map((band) => {
    const conditions = ["category_id IS NOT NULL"];
    if (band.lower !== null)
      conditions.push(`cgpa >= ${q.bind(band.lower)}::numeric`);
    if (band.upper !== null)
      conditions.push(`cgpa < ${q.bind(band.upper)}::numeric`);
    return `jsonb_build_object('id',${q.bind(band.id)}::text,'count',count(*) FILTER(WHERE ${conditions.join(" AND ")}))`;
  });
  const { rows } = await client.query(
    `${q.sql} SELECT
    count(*)::int AS total,
    count(*) FILTER(WHERE category_id IS NOT NULL)::int AS valid,
    count(*) FILTER(WHERE cgpa IS NULL)::int AS missing,
    count(*) FILTER(WHERE cgpa IS NOT NULL AND category_id IS NULL)::int AS invalid,
    (avg(cgpa) FILTER(WHERE category_id IS NOT NULL))::text AS average,
    jsonb_build_array(${categories.join(",")}) AS categories,
    jsonb_build_array(${distribution.join(",")}) AS distribution FROM cohort`,
    q.values,
  );
  const row = rows[0];
  const percent = (count) => (row.total ? (count * 100) / row.total : 0);
  const summary = {
    total: row.total,
    valid: row.valid,
    missing: row.missing,
    invalid: row.invalid,
    unclassified: row.missing + row.invalid,
    averageCgpa: row.average,
    scale: CGPA_SCALE,
    placementPolicy: PLACEMENT_POLICY,
    categories: CATEGORY_RULES.map((rule) => {
      const stats = row.categories.find((item) => item.id === rule.id);
      return {
        ...rule,
        ...stats,
        percentage: percent(stats.count),
        eligibleCount: stats.eligibleCount,
        eligibilityPercentage: stats.count ? 100 * stats.eligibleCount / stats.count : 0,
      };
    }),
    distribution: DISTRIBUTION_BANDS.map((band) => {
      const stats = row.distribution.find((item) => item.id === band.id);
      return {
        id: band.id,
        label: band.label,
        count: stats.count,
        percentage: percent(stats.count),
      };
    }),
  };
  if (
    summary.categories.reduce((sum, item) => sum + item.count, 0) !==
      summary.valid ||
    summary.valid + summary.unclassified !== summary.total
  )
    throw new Error("Analytics reconciliation failed");
  return summary;
}

export async function categoryStudents(
  client,
  filters,
  category,
  summary,
  exportAll = false,
) {
  const count = summary.categories.find((item) => item.id === category).count;
  const limit = filters.limit || 25;
  const page = Math.min(
    filters.page || 1,
    Math.max(1, Math.ceil(count / limit)),
  );
  const q = cohortQuery(filters);
  const categoryParam = q.bind(category);
  const eligible = placementSql('ranked.cgpa', q.bind);
  // Tied CGPAs share competition rank (1,1,3); enrollment + UUID determine display order.
  const paging = exportAll
    ? ""
    : `LIMIT ${q.bind(limit)} OFFSET ${q.bind((page - 1) * limit)}`;
  const result = await client.query(
    `${q.sql}, ranked AS (
    SELECT *,rank() OVER(ORDER BY cgpa DESC)::int AS rank FROM cohort WHERE category_id=${categoryParam}
  ) SELECT *,(${eligible}) AS placement_eligible FROM ranked ORDER BY cgpa DESC,enrollment_no COLLATE "C",id ${paging}`,
    q.values,
  );
  return { students: result.rows, pagination: { total: count, page, limit } };
}

export async function batchBreakdown(client, filters) {
  const q = cohortQuery(filters);
  const columns = CATEGORY_RULES.map(
    (rule) =>
      `count(*) FILTER(WHERE category_id=${q.bind(rule.id)})::int AS "${rule.id}"`,
  );
  const result = await client.query(
    `${q.sql} SELECT source_batch,count(*)::int AS total,
    count(*) FILTER(WHERE category_id IS NOT NULL)::int AS valid,
    count(*) FILTER(WHERE category_id IS NULL)::int AS unclassified,
    (avg(cgpa) FILTER(WHERE category_id IS NOT NULL))::text AS average,
    ${columns.join(",")} FROM cohort GROUP BY source_batch ORDER BY source_batch DESC`,
    q.values,
  );
  return result.rows;
}

export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}
export function categoryCsv(students, category) {
  const rule = categoryDefinition(category);
  const rows = [
    [
      "Rank",
      "USN",
      "Student name",
      "Department",
      "Batch",
      "CGPA (stored precision)",
      "Category",
      "CGPA range",
      "Placement eligibility",
    ],
  ];
  for (const s of students)
    rows.push([
      s.rank,
      s.enrollment_no,
      s.full_name,
      s.department_short_name,
      s.source_batch,
      s.cgpa,
      rule.name,
      rule.conditionLabel,
      placementLabel(s.cgpa),
    ]);
  return (
    "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}

export function registerAnalytics(api, { run, audit, httpError }) {
  const consistent = { repeatableRead: true };
  for (const route of [
    "/student-categories",
    "/analytics",
    "/batch-analytics",
  ]) {
    api.get(route, async (req) => {
      const filters = filtersSchema.strict().parse(req.query);
      return run(
        req,
        ["admin", "staff"],
        async (client) => {
          const summary = await analyticsSummary(client, filters);
          const options = await filterOptions(client);
          const batches =
            route === "/batch-analytics"
              ? await batchBreakdown(client, filters)
              : undefined;
          await audit(client, req, "analytics.read");
          return {
            data: {
              summary,
              options,
              filters,
              ...(batches ? { batches } : {}),
            },
          };
        },
        consistent,
      );
    });
  }
  api.get("/student-categories/:category", async (req) => {
    const parsed = categorySchema.safeParse(req.params.category);
    if (!parsed.success)
      throw httpError(404, "NOT_FOUND", "Student category not found.");
    const filters = listSchema.parse(req.query);
    return run(
      req,
      ["admin", "staff"],
      async (client) => {
        const summary = await analyticsSummary(client, filters);
        const list = await categoryStudents(
          client,
          filters,
          parsed.data,
          summary,
        );
        const options = await filterOptions(client);
        await audit(client, req, "category.read", parsed.data);
        return {
          data: {
            category: categoryDefinition(parsed.data),
            summary,
            options,
            filters,
            ...list,
          },
        };
      },
      consistent,
    );
  });
  api.get(
    "/student-categories/:category/export",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const parsed = categorySchema.safeParse(req.params.category);
      if (!parsed.success)
        throw httpError(404, "NOT_FOUND", "Student category not found.");
      const filters = filtersSchema.strict().parse(req.query);
      return run(
        req,
        ["admin"],
        async (client) => {
          const summary = await analyticsSummary(client, filters);
          if (
            summary.categories.find((item) => item.id === parsed.data).count >
            20000
          )
            throw httpError(
              413,
              "EXPORT_TOO_LARGE",
              "Narrow the batch or department filter to export at most 20,000 students.",
            );
          const { students } = await categoryStudents(
            client,
            filters,
            parsed.data,
            summary,
            true,
          );
          await audit(client, req, "category.export", parsed.data);
          return {
            data: {
              filename: `dsu-${parsed.data}.csv`,
              content: categoryCsv(students, parsed.data),
              rows: students.length,
            },
          };
        },
        consistent,
      );
    },
  );
}
