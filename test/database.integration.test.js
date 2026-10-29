import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/platform/database/migrations.js";
import { testDatabase } from "./helpers/database.js";
import { completeOnboarding } from "./helpers/onboarding.js";

test(
  "fresh migrations and backend authorization work with restricted roles",
  { timeout: 120000 },
  async (t) => {
    const { db, pool, operator } = await testDatabase();
    const users = {
      a: randomUUID(),
      b: randomUUID(),
      officer: randomUUID(),
      admin: randomUUID(),
      outsider: randomUUID(),
    };
    const studentA = randomUUID(),
      studentB = randomUUID();
    await migrate(operator); // A second deployment must not reapply existing migrations.
    const migrationCount = (
      await db.query("SELECT count(*)::int AS n FROM erp.schema_migrations")
    ).rows[0].n;
    assert.ok(migrationCount >= 12);
    await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [
      Object.values(users),
    ]);
    await db.query(
      "INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash) VALUES($1,'TEST001','Student A','2028','a'),($2,'TEST002','Student B','2028','b')",
      [studentA, studentB],
    );
    await db.query(
      "INSERT INTO erp.academics(student_id,cgpa,current_backlog) VALUES($1,8.5,0),($2,7,0)",
      [studentA, studentB],
    );
    await db.query(
      "INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2),($3,'student',$4),($5,'admin',NULL)",
      [users.a, studentA, users.b, studentB, users.admin],
    );
    await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [
      users.officer,
    ]);
    // Student A has completed skills onboarding (dashboard and /session home).
    await completeOnboarding(db, studentA);
    const app = await buildApp({
      pool,
      env: { SERVICE_TOKEN: "x".repeat(32), RATE_LIMIT_USER_MAX: 100 },
      logger: false,
      verify: async (token) => ({ id: users[token] }),
    });
    t.after(() => app.close());
    const get = (url, user = "a") =>
      app.inject({
        url: "/api/v1" + url,
        headers: { authorization: "Bearer " + user },
      });
    assert.equal((await app.inject('/api/v1/session')).statusCode,401);
    assert.deepEqual((await get('/session')).json().data,{role:'student',home:'/student',onboardingRequired:false});
    assert.deepEqual((await get('/session?portal=student','officer')).json().data,{role:'placement_officer',home:'/placement',onboardingRequired:false});
    assert.deepEqual((await get('/session?portal=placement-officer')).json().data,{role:'student',home:'/student',onboardingRequired:false});
    assert.deepEqual((await get('/session','admin')).json().data,{role:null,home:'/access',onboardingRequired:false});
    assert.deepEqual((await get('/session','outsider')).json().data,{role:null,home:'/onboarding',onboardingRequired:false});
    assert.deepEqual((await get('/session','b')).json().data,{role:'student',home:'/student/onboarding',onboardingRequired:true});
    await db.query('UPDATE placement.officers SET active=false WHERE user_id=$1',[users.officer]);
    assert.equal((await get('/session','officer')).json().data.role,null);
    await db.query('UPDATE placement.officers SET active=true WHERE user_id=$1',[users.officer]);
    assert.equal((await app.inject("/api/v1/student/me")).statusCode, 401);
    const own = await get("/student/me");
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().data.id, studentA);
    assert.equal((await get("/student/me", "outsider")).statusCode, 403);
    assert.equal((await get("/student/me", "officer")).statusCode, 403);
    assert.equal(
      (
        await get(
          "/portal/read?" +
            new URLSearchParams({ path: "/students/" + studentB }),
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await get("/portal/read?" + new URLSearchParams({ path: "/students" })))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await get(
          "/portal/read?" + new URLSearchParams({ path: "//evil.invalid/me" }),
        )
      ).statusCode,
      400,
    );
    assert.equal((await get("/placement/session")).statusCode, 403);
    assert.equal(
      (await get("/placement/session", "officer")).json().data.role,
      "placement_officer",
    );
    const profile = await get("/placement/student?id=" + studentA, "officer");
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().data.academic.student_id, undefined);
    const company = await app.inject({
      method: "POST",
      url: "/api/v1/placement/actions/company.save",
      headers: { authorization: "Bearer officer" },
      payload: {
        payload: { name: "Synthetic Company" },
        requestId: randomUUID(),
      },
    });
    assert.equal(company.statusCode, 200);
    assert.equal(company.json().data.name, "Synthetic Company");
    const rename = (id, title, user = "officer") =>
      app.inject({
        method: "POST",
        url: "/api/v1/placement/friday/rename",
        headers: { authorization: "Bearer " + user },
        payload: { id, title },
      });
    const conversation = randomUUID();
    await db.query(
      "INSERT INTO placement.conversations(id,owner_id,assistant,title) VALUES($1,$2,'friday','Original')",
      [conversation, users.officer],
    );
    assert.equal(
      (await rename(conversation, "Updated conversation")).json().data.title,
      "Updated conversation",
    );
    assert.equal(
      (await rename(conversation, "Student overwrite", "a")).statusCode,
      403,
    );
    assert.equal((await rename(randomUUID(), "Missing")).statusCode, 404);
    assert.equal((await rename(conversation, "bad\ntitle")).statusCode, 400);
    assert.equal((await get("/imports", "officer")).statusCode, 200);
    assert.equal((await get("/imports", "a")).statusCode, 403);
    assert.equal(
      (await db.query("SELECT current_setting('app.user_id',true) AS id"))
        .rows[0].id,
      "",
    );
    assert.equal(
      (
        await db.query(
          "SELECT current_setting('request.jwt.claims',true) AS claims",
        )
      ).rows[0].claims,
      "",
    );
    const studentProfile = await get("/student/profile");
    assert.equal(studentProfile.statusCode, 200);
    assert.equal(studentProfile.json().data.official.enrollment_no, "TEST001");
    const profileSave = await app.inject({
      method: "POST",
      url: "/api/v1/student/profile",
      headers: { authorization: "Bearer a" },
      payload: {
        details: { fullName: "My student display name" },
        revision: 0,
        complete: true,
      },
    });
    assert.equal(profileSave.statusCode, 200);
    assert.equal(profileSave.json().data.onboarded, true);
    assert.equal(
      (await get("/student/profile", "b")).json().data.onboarded,
      false,
    );
    assert.equal(
      (
        await db.query("SELECT full_name FROM erp.students WHERE id=$1", [
          studentA,
        ])
      ).rows[0].full_name,
      "Student A",
    );
    assert.equal((await get("/student/dashboard")).statusCode, 200);
    // The final cutover closes the old PostgREST bypass without breaking the backend.
    await db.exec(
      "REVOKE EXECUTE ON FUNCTION public.dsu_portal_read(text,jsonb),public.dsu_batch_read(text,jsonb),public.dsu_placement_read(text,jsonb),public.dsu_placement_mutate(text,jsonb,uuid),public.dsu_placement_imports(),public.dsu_friday_rename(uuid,text) FROM authenticated",
    );
    assert.equal((await get("/student/me")).statusCode, 200);
    assert.equal((await rename(conversation, "After cutover")).statusCode, 200);
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      () => db.query("SELECT public.dsu_portal_read('/me','{}')"),
      (error) => error.code === "42501",
    );
    await db.exec("RESET ROLE");
    const saved = (
      await db.query("SELECT name,checksum FROM erp.schema_migrations LIMIT 1")
    ).rows[0];
    await db.query(
      "UPDATE erp.schema_migrations SET checksum='tampered' WHERE name=$1",
      [saved.name],
    );
    await assert.rejects(() => migrate(operator), /checksum changed/);
    await db.query(
      "UPDATE erp.schema_migrations SET checksum=$2 WHERE name=$1",
      [saved.name, saved.checksum],
    );
  },
);
