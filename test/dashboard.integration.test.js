import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { runStudent } from "../src/modules/students/context.js";
import { dashboardData } from "../src/modules/students/dashboard.js";

test("dashboard uses one data round trip and keeps each student's snapshot private", async () => {
  const { db, pool } = await testDatabase();
  const users = [randomUUID(), randomUUID()];
  try {
    for (const [index, actor] of users.entries()) {
      const id = randomUUID();
      await db.query("INSERT INTO auth.users(id) VALUES($1)", [actor]);
      await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash) VALUES($1,$2,$3,'2028',$4)", [id, `DASH${index}`, `Student ${index}`, actor]);
      await db.query("INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)", [actor, id]);
      await db.query("INSERT INTO student.profiles(user_id,details,onboarded) VALUES($1,$2,true)", [actor, JSON.stringify({ fullName: `Private ${index}` })]);
      await db.query("INSERT INTO student.notifications(user_id,title,body) VALUES($1,$2,'Private update')", [actor, `Notice ${index}`]);
      await db.query("INSERT INTO student.activity(user_id,kind) VALUES($1,'interview.completed')", [actor]);
    }
    for (const [index, actor] of users.entries()) {
      let reads = 0;
      const data = await runStudent(pool, actor, (client, official) => dashboardData({
        query(sql, values) { reads++; return client.query(sql, values); },
      }, official, actor));
      assert.equal(reads, 1, "avoid restoring sequential network round trips");
      assert.equal(data.profile.fullName, `Private ${index}`);
      assert.deepEqual(data.notifications.map((notice) => notice.title), [`Notice ${index}`]);
      assert.equal(data.activity[0].count, 1);
      assert.equal(data.streak.current, 1);
      assert.equal(data.score, null);
      assert.equal(data.resume, null);
      assert.equal(data.latestSession, null);
      assert.equal(data.pipeline.total, 0);
      for (const field of ["schedule", "deadlines", "applications"]) assert.deepEqual(data[field], []);
    }
  } finally { await pool.end(); }
});
