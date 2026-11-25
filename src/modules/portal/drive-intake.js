// Officer recruiter-PDF intake: reads a recruiter's drive notice and suggests
// company details and the role's drive details for the officer to review in
// the company editor. Nothing is saved to placement.companies or
// placement.drives, or published, here.
import { createHash } from "node:crypto";
import { z } from "zod";
import { withActor } from "../../integrations/supabase/db.js";
import { httpError } from "../../platform/http/errors.js";
import { decodeUpload, extractDocument } from "../students/documents.js";

export const DRIVE_FIELDS = [
  "company_name",
  "title",
  "package_lpa",
  "location",
  "drive_date",
  "registration_deadline",
  "min_cgpa",
  "max_backlogs",
  "branches",
  "skills",
  "description",
  "rounds",
  "required_documents",
  "job_category",
  "employment_type",
  "openings",
  "contact",
];
export const COMPANY_FIELDS = [
  "name",
  "short_name",
  "industry",
  "headquarters",
  "website",
  "hr_name",
  "hr_email",
  "hr_phone",
  "about",
  "hiring_roles",
  "job_categories",
];
const EMPLOYMENT_TYPES = ["full-time", "internship", "internship-ppo", "contract"];
export const AI_TEXT_LIMIT = 40000;
const LABELS = {
  package_lpa: "Package",
  drive_date: "Drive date",
  registration_deadline: "Registration deadline",
  min_cgpa: "Minimum CGPA",
  max_backlogs: "Maximum backlogs",
  employment_type: "Employment type",
  openings: "Openings",
};
// Numbers and dates are validated on the server, so a model mistake becomes a
// warning and an empty field instead of a failed import.
export const driveExtractionSchema = z
  .object({
    company_name: z.string(),
    title: z.string(),
    package_lpa: z.number().nullable(),
    location: z.string(),
    drive_date: z.string(),
    registration_deadline: z.string(),
    min_cgpa: z.number().nullable(),
    max_backlogs: z.number().nullable(),
    branches: z.array(z.string()).max(100),
    skills: z.string(),
    description: z.string(),
    rounds: z.array(z.string()).max(30),
    required_documents: z.string(),
    job_category: z.string(),
    employment_type: z.string(),
    openings: z.number().nullable(),
    contact: z.string(),
    notes: z.array(z.string()).max(10),
  })
  .strict();
// Officer recruiter PDFs also describe the company itself (the company portal's
// own drive upload keeps the drive-only schema above).
export const recruiterExtractionSchema = driveExtractionSchema
  .extend({
    company: z
      .object({
        short_name: z.string(),
        industry: z.string(),
        headquarters: z.string(),
        website: z.string(),
        hr_name: z.string(),
        hr_email: z.string(),
        hr_phone: z.string(),
        about: z.string(),
        hiring_roles: z.string(),
        job_categories: z.array(z.string()).max(20),
      })
      .strict(),
  })
  .strict();
const TASK =
  "Extract campus placement drive details from documentText, a recruiter's drive notice. Use only what the document states. When a field is not stated, return an empty string, null or an empty list; never guess, infer from the company name or invent. company_name: the hiring company. title: the job role. package_lpa: annual CTC in lakhs per annum as a number (₹6,00,000 per annum is 6); for a range use the lower bound and say so in notes; null when only a stipend or no package is given. Dates as YYYY-MM-DD; when the year is missing and today does not make it unambiguous, leave the date empty and add a note. min_cgpa on a 10-point scale; when only a percentage is given leave it null and add a note. max_backlogs: allowed active backlogs. branches: eligible branches as written (e.g. CSE, ISE, ECE). rounds: selection rounds in order. employment_type: one of full-time, internship, internship-ppo, contract, or empty. openings: number of positions. contact: coordinator or HR contact details as written. description: a faithful summary of the role and responsibilities. company: details about the hiring company itself, only as stated: short_name (abbreviation or brand name), industry, headquarters (city or head office), website (as written), hr_name, hr_email and hr_phone (the recruiter or HR contact person), about (a faithful summary of what the company does), hiring_roles (roles the company hires for, comma separated), job_categories (broad categories such as Software / IT, Data & analytics, Core engineering, Consulting). notes: short points the officer should double-check.";

const clean = (value, max) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim()
        .slice(0, max)
    : "";
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const list = (values, maxItems, maxLength) => [
  ...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => clean(value, maxLength))
      .filter(Boolean),
  ),
].slice(0, maxItems);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Validates suggested company details; anything unusable becomes empty plus a warning. */
export function normalizeCompanyExtraction(raw, companyName = "") {
  const company = raw && typeof raw === "object" ? raw : {};
  const warnings = [];
  let website = clean(company.website, 200);
  // "acme.com" is a website; "https://" is added so it saves as a link.
  if (website && !/^https?:\/\//i.test(website)) website = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(website) ? "https://" + website : "";
  if (clean(company.website, 200) && !website)
    warnings.push(`Website "${clean(company.website, 200)}" is not a web address and was left blank.`);
  let email = clean(company.hr_email, 200);
  if (email && !EMAIL.test(email)) {
    warnings.push(`HR email "${email}" is not an email address and was left blank.`);
    email = "";
  }
  const fields = {
    name: clean(companyName, 200),
    short_name: clean(company.short_name, 50),
    industry: clean(company.industry, 100),
    headquarters: clean(company.headquarters, 200),
    website,
    hr_name: clean(company.hr_name, 200),
    hr_email: email,
    hr_phone: clean(company.hr_phone, 40),
    about: clean(company.about, 4000),
    hiring_roles: clean(company.hiring_roles, 1000),
    job_categories: list(company.job_categories, 20, 100),
  };
  const missingFields = COMPANY_FIELDS.filter((key) => {
    const value = fields[key];
    return value === "" || (Array.isArray(value) && !value.length);
  });
  return { fields, missingFields, warnings };
}

/** Validates suggested fields; anything unusable becomes empty plus a warning. */
export function normalizeDriveExtraction(raw) {
  const warnings = [];
  const number = (key, min, max, integer = false) => {
    const value = raw[key];
    if (value === null || value === undefined) return null;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      warnings.push(`${LABELS[key]} "${value}" was not a valid value and was left blank.`);
      return null;
    }
    return value;
  };
  const date = (key) => {
    const value = clean(raw[key], 40);
    if (!value) return "";
    if (!validDate(value)) {
      warnings.push(`${LABELS[key]} "${value}" was not a valid date and was left blank.`);
      return "";
    }
    return value;
  };
  let employment = clean(raw.employment_type, 40).toLowerCase();
  if (employment && !EMPLOYMENT_TYPES.includes(employment)) {
    warnings.push(`Employment type "${employment}" is not a supported type and was left blank.`);
    employment = "";
  }
  const fields = {
    company_name: clean(raw.company_name, 200),
    title: clean(raw.title, 200),
    package_lpa: number("package_lpa", 0, 10000),
    location: clean(raw.location, 200),
    drive_date: date("drive_date"),
    registration_deadline: date("registration_deadline"),
    min_cgpa: number("min_cgpa", 0, 10),
    max_backlogs: number("max_backlogs", 0, 100, true),
    branches: list(raw.branches, 100, 100),
    skills: clean(raw.skills, 2000),
    description: clean(raw.description, 12000),
    rounds: list(raw.rounds, 20, 100),
    required_documents: clean(raw.required_documents, 2000),
    job_category: clean(raw.job_category, 100),
    employment_type: employment,
    openings: number("openings", 1, 99999, true),
    contact: clean(raw.contact, 500),
  };
  if (
    fields.drive_date &&
    fields.registration_deadline &&
    fields.registration_deadline > fields.drive_date
  )
    warnings.push(
      "The registration deadline is after the drive date. Check both dates before saving.",
    );
  for (const note of list(raw.notes, 10, 300)) warnings.push(note);
  const missingFields = DRIVE_FIELDS.filter((key) => {
    const value = fields[key];
    return value === null || value === "" || (Array.isArray(value) && !value.length);
  });
  return { fields, missingFields, warnings };
}

const emptyFields = () => normalizeDriveExtraction({}).fields;

export function registerDriveIntakeRoutes(api, { pool, generate }) {
  // The company editor reads recruiter PDFs; the drive path is kept for older web builds.
  for (const path of ["/placement/companies/parse", "/placement/drives/parse"])
  api.post(
    path,
    {
      bodyLimit: 15 * 1024 * 1024,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req) => {
      const input = z
        .object({
          filename: z
            .string()
            .trim()
            .min(5)
            .max(200)
            .regex(/\.pdf$/i),
          data: z.string().max(14 * 1024 * 1024),
        })
        .strict()
        .parse(req.body);
      const actor = req.actor.id;
      await withActor(pool, actor, async (client) => {
        const { rows } = await client.query("SELECT student.is_officer() AS officer");
        if (!rows[0]?.officer)
          throw httpError(403, "FORBIDDEN", "Placement Officer access is required.");
      });
      const buffer = decodeUpload(input.data);
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw httpError(400, "INVALID_FILE_TYPE", "Choose a PDF drive notice.");
      const document = await extractDocument(input.filename, buffer);
      const warnings = [];
      let result;
      let company = normalizeCompanyExtraction({});
      if (!document.content.trim() || document.lowText) {
        // Too little text to read: nothing is sent to the AI and nothing is guessed.
        warnings.push(
          "This PDF looks scanned or image-based, so almost no text could be read. Fill in the fields manually from the notice.",
        );
        result = {
          fields: emptyFields(),
          missingFields: [...DRIVE_FIELDS],
          warnings: [],
        };
      } else {
        // The AI reads at most AI_TEXT_LIMIT characters of the stored text.
        if (document.truncated || document.content.length > AI_TEXT_LIMIT)
          warnings.push(
            "Only the first part of this long document was read. Check the remaining pages manually.",
          );
        const raw = await generate(
          actor,
          "officer.drive.parse",
          TASK,
          {
            documentText: document.content.slice(0, AI_TEXT_LIMIT),
            today: new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Kolkata",
            }).format(new Date()),
          },
          recruiterExtractionSchema,
          { officer: true },
        );
        result = normalizeDriveExtraction(raw);
        company = normalizeCompanyExtraction(raw.company, result.fields.company_name);
      }
      const filename = input.filename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
      const intake = await withActor(pool, actor, async (client) => (
        await client.query(
          "INSERT INTO placement.drive_intakes(created_by,filename,sha256,page_count,chars,truncated,low_text,content,extracted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,created_at",
          [
            actor,
            filename,
            createHash("sha256").update(buffer).digest("hex"),
            document.pageCount,
            document.chars,
            document.truncated,
            document.lowText,
            document.content,
            JSON.stringify({ ...result.fields, company: company.fields }),
          ],
        )
      ).rows[0]);
      return {
        data: {
          intakeId: intake.id,
          fields: result.fields,
          missingFields: result.missingFields,
          company: company.fields,
          missingCompanyFields: company.missingFields,
          warnings: [...warnings, ...company.warnings, ...result.warnings],
          document: {
            filename,
            pageCount: document.pageCount,
            chars: document.chars,
            truncated: document.truncated,
            lowText: document.lowText,
            stored: "text-only",
          },
          text: document.content,
        },
      };
    },
  );
}
