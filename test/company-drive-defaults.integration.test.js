import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { testDatabase } from "./helpers/database.js";

test("companies keep validated default drive details", { timeout: 120000 }, async (t) => {
  const { db, pool } = await testDatabase();
  const officer = randomUUID();
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [officer]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [officer]);
  const app = await buildApp({
    pool, logger: false,
    env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 100 },
    verify: async () => ({ id: officer }),
  });
  t.after(() => app.close());
  const act = (action, payload) => app.inject({
    method: "POST", url: "/api/v1/placement/actions/" + action,
    headers: { authorization: "Bearer officer" },
    payload: { payload, requestId: randomUUID() },
  });
  const read = (resource, query) => app.inject({
    url: `/api/v1/placement/${resource}?${new URLSearchParams(query)}`,
    headers: { authorization: "Bearer officer" },
  });

  // A company without defaults stores an empty object.
  const plain = (await act("company.save", { name: "Plain Co" })).json().data;
  assert.deepEqual(plain.drive_defaults, {});

  // The officer form sends the defaults as JSON text; unknown keys are dropped,
  // text is trimmed, numbers are stored as numbers and round order is kept.
  const defaults = {
    title: "  Graduate Engineer ", job_category: "Software / IT", employment_type: "full-time",
    package_lpa: "8.5", openings: 12, min_cgpa: "7", max_backlogs: "0", min_attendance: "",
    location: "Bengaluru", branches: ["ISE", "CSE", "CSE", " "], rounds: ["Aptitude", "Technical", "HR"],
    skills: "Java, SQL", description: "Build services.", required_documents: "Resume",
    drive_date: "2027-01-22", registration_deadline: "2027-01-15", batch: "2027", unknown: "x",
  };
  const created = (await act("company.save", { name: "Acme Systems", drive_defaults: JSON.stringify(defaults) })).json().data;
  assert.deepEqual(created.drive_defaults, {
    title: "Graduate Engineer", job_category: "Software / IT", employment_type: "full-time",
    package_lpa: 8.5, openings: 12, min_cgpa: 7, max_backlogs: 0, location: "Bengaluru",
    branches: ["CSE", "ISE"], rounds: ["Aptitude", "Technical", "HR"],
    skills: "Java, SQL", description: "Build services.", required_documents: "Resume",
  });

  // Both company reads return the defaults, which the drive form starts from.
  const one = (await read("company", { id: created.id })).json().data;
  assert.equal(one.drive_defaults.title, "Graduate Engineer");
  const list = (await read("companies", { active: "true", limit: "100" })).json().data;
  assert.equal(list.rows.find((c) => c.id === created.id).drive_defaults.openings, 12);

  // Saving without drive_defaults keeps them; an empty value clears them.
  const renamed = (await act("company.save", { id: created.id, revision: created.revision, name: "Acme Systems Ltd" })).json().data;
  assert.equal(renamed.drive_defaults.title, "Graduate Engineer");
  const cleared = (await act("company.save", { id: created.id, revision: renamed.revision, name: "Acme Systems Ltd", drive_defaults: "" })).json().data;
  assert.deepEqual(cleared.drive_defaults, {});

  // Invalid values are refused with a message, never stored half-valid.
  for (const [bad, message] of [
    [{ min_cgpa: "11" }, /Default minimum CGPA is out of range/],
    [{ openings: "2.5" }, /Default openings is out of range/],
    [{ package_lpa: "eight" }, /Default package must be a number/],
    [{ employment_type: "freelance" }, /valid default employment type/],
    ["not json", /Default drive details are not valid/],
  ]) {
    const response = await act("company.save", { name: "Bad Co", drive_defaults: typeof bad === "string" ? bad : JSON.stringify(bad) });
    assert.equal(response.statusCode, 400, JSON.stringify(bad));
    assert.match(response.json().error.message, message);
  }
});
