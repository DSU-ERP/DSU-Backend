import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { testDatabase } from "./database.js";
import { makePdf } from "./pdf.js";

// Synthetic cohort, in-memory database only. [usn, batch, department, cgpa, backlogs]
const COHORT = [
  ["C01", "2027", "CSE", "9.10", 0],
  ["C02", "2027", "CSE", "8.40", 0],
  ["C03", "2027", "CSE", "6.90", 0], // below the officer's CGPA rule, hand-picked
  ["C04", "2027", "ECE", "9.30", 0], // other branch
  ["C05", "2028", "CSE", "9.50", 0], // other batch
  ["C06", "2027", "CSE", "8.80", 3], // too many backlogs
];

export function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    configured: true,
    async upload(bucket, path, buffer) { objects.set(`${bucket}/${path}`, buffer); },
    async signedUrl(bucket, path) {
      assert.ok(objects.has(`${bucket}/${path}`), "only stored objects are signed");
      return { url: `https://storage.invalid/${bucket}/${path}?token=x`, expiresIn: 300 };
    },
    async remove(bucket, path) { objects.delete(`${bucket}/${path}`); },
  };
}

export const EXTRACTION = {
  company_name: "Acme", title: "Graduate Engineer", package_lpa: 12, location: "Bengaluru", drive_date: "", registration_deadline: "",
  min_cgpa: 7.5, max_backlogs: 0, branches: ["CSE", "ISE"], skills: "Java, SQL", description: "Build and test backend services for payments.",
  rounds: ["Online test", "Technical interview", "HR interview"], required_documents: "Resume", job_category: "Software",
  employment_type: "full-time", openings: 10, contact: "", notes: [],
};

export async function companySetup({ studentAi } = {}) {
  const { db, pool } = await testDatabase();
  const ids = {};
  for (const [usn, batch, dept, cgpa, backlogs] of COHORT) {
    ids[usn] = randomUUID();
    await db.query(
      `INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name,department_name,current_semester)
       VALUES($1,$2,'Student '||$2,$3,'h',$4,$4||' Engineering','7')`,
      [ids[usn], usn, batch, dept],
    );
    await db.query("INSERT INTO erp.academics(student_id,cgpa,current_backlog,attendance) VALUES($1,$2,$3,90)", [ids[usn], cgpa, backlogs]);
    await db.query("INSERT INTO erp.contacts(student_id,details) VALUES($1,$2)", [ids[usn], JSON.stringify({ email: usn.toLowerCase() + "@dsu.test", phoneStudent1: "90000" + usn.slice(1), fatherName: "Private" })]);
  }
  const users = {
    officer: randomUUID(), s1: randomUUID(), s3: randomUUID(), s4: randomUUID(), s5: randomUUID(),
    hrA: randomUUID(), hrB: randomUUID(), stranger: randomUUID(), wrongEmail: randomUUID(),
  };
  const emails = { hrA: "hr@acme.test", hrB: "talent@beta.test", stranger: "someone@else.test", wrongEmail: "other@acme.test", s1: "c01@dsu.test" };
  for (const [key, id] of Object.entries(users))
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, emails[key] || key + "@x.test"]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [users.officer]);
  for (const [user, usn] of [["s1", "C01"], ["s3", "C03"], ["s4", "C04"], ["s5", "C05"]])
    await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [users[user], ids[usn]]);
  const companies = {};
  for (const [key, name] of [["A", "Acme Systems"], ["B", "Beta Labs"]])
    companies[key] = (await db.query("INSERT INTO placement.companies(name,industry,about) VALUES($1,'Software','Builds payments software.') RETURNING id", [name])).rows[0].id;

  const storage = fakeStorage();
  const aiCalls = [];
  const app = await buildApp({
    pool, logger: false, storage,
    env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 1000 },
    verify: async (token) => ({ id: users[token] }),
    studentAi: async (call) => { aiCalls.push(call); return studentAi ? studentAi(call) : EXTRACTION; },
  });
  const request = (method, path, who, body) =>
    app.inject({ method, url: "/api/v1" + path, headers: { authorization: "Bearer " + who }, ...(body === undefined ? {} : { payload: body }) });
  const ok = async (method, path, who, body) => {
    const response = await request(method, path, who, body);
    assert.ok(response.statusCode === 200, `${method} ${path} as ${who}: ${response.statusCode} ${response.body}`);
    return response.json().data;
  };
  const fails = async (status, method, path, who, body, pattern) => {
    const response = await request(method, path, who, body);
    assert.equal(response.statusCode, status, `${method} ${path} as ${who}: ${response.body}`);
    if (pattern) assert.match(response.json().error.message, pattern);
    return response.json();
  };
  return { db, pool, ids, users, companies, storage, aiCalls, app, request, ok, fails };
}

export const pdf = (lines) => makePdf(lines).toString("base64");
export const JD_LINES = [
  "Acme Systems campus hiring 2027: Graduate Engineer",
  "Role: build and test backend services for our payments platform in Java and SQL.",
  "Package: CTC 12 LPA (10 LPA fixed and 2 LPA variable). Location: Bengaluru, hybrid.",
  "Eligibility: CSE and ISE graduates of 2027 with CGPA 7.5 or above and no active backlogs.",
  "Selection process: online test, technical interview and HR interview. Openings: 10.",
  "Documents: updated resume and college ID. Bond: one year service agreement.",
];

