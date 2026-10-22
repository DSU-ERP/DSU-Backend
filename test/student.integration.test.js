import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { testDatabase } from "./helpers/database.js";
import {
  practiceQuestions,
  CATEGORIES,
} from "../src/modules/students/practice-bank.js";

test(
  "student journeys persist privately behind the restricted runtime role",
  { timeout: 120000 },
  async (t) => {
    const { db, pool } = await testDatabase();
    const users = { a: randomUUID(), b: randomUUID(), officer: randomUUID() },
      students = [randomUUID(), randomUUID()];
    await db.query("INSERT INTO auth.users(id) SELECT unnest($1::uuid[])", [
      Object.values(users),
    ]);
    for (const [i, user] of ["a", "b"].entries()) {
      await db.query(
        "INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash) VALUES($1,$2,$3,$4,$5)",
        [students[i], "ST00" + i, "Student " + user, i ? "2029" : "2028", user],
      );
      await db.query(
        "INSERT INTO erp.academics(student_id,cgpa,current_backlog) VALUES($1,8,0)",
        [students[i]],
      );
      await db.query(
        "INSERT INTO erp.memberships(user_id,role,student_id) VALUES($1,'student',$2)",
        [users[user], students[i]],
      );
    }
    await db.query("INSERT INTO placement.officers(user_id) VALUES($1)", [
      users.officer,
    ]);
    let failEvaluation = false;
    const feedback = {
      scores: {
        relevance: 8,
        clarity: 7,
        confidence: 6,
        structure: 7,
        specificity: 6,
        roleFit: 7,
        communication: 8,
        depth: 7,
        conciseness: 7,
        accuracy: 7,
        overall: 7,
      },
      quality: "Good",
      explanation: "Use more specific evidence.",
      strengths: ["Clear structure"],
      improvements: ["Quantify the outcome"],
      followUp: null,
      turn: { kind: "answer", scored: true, reason: "A genuine answer." },
      star: {
        applicable: false,
        situation: false,
        task: false,
        action: false,
        result: false,
        missing: [],
        score: null,
        feedback: null,
      },
    };
    const sampleQuestion = {
      section: "Reasoning",
      type: "mcq",
      question: "Which number equals two plus two?",
      options: ["Three", "Four"],
      correctIndex: 1,
      expectedPoints: [],
      marks: 2,
      explanation: "Two plus two equals four.",
    };
    const ai = async ({ kind, input }) => {
      // Provider fixtures test persistence, validation and ownership without paid calls.
      await db.exec("DELETE FROM student.ai_requests");
      if (kind === "interview.evaluate") {
        if (failEvaluation) throw Error("simulated provider outage");
        return feedback;
      }
      if (kind === "interview.generate")
        return {
          title: "Graduate role preparation",
          company: "",
          role: "Graduate engineer",
          keywords: ["Projects"],
          questions: Array.from(
            { length: input.config.questionCount },
            (_, i) => ({
              question: "Describe your project example " + i,
              focus: "Projects",
              expectedPoints: ["Actual evidence"],
            }),
          ),
          context: {
            jdSummary: "",
            responsibilities: [],
            mustHaveSkills: [],
            resumeSummary: "",
            strengths: [],
            risks: [],
            objective: "Assess project evidence.",
            sections: [
              {
                name: "Projects",
                description: "Project evidence",
                questionCount: input.config.questionCount,
              },
            ],
          },
        };
      if (kind === "interview.coach")
        return {
          title: "Build a clearer answer",
          explanation: "Use your own evidence.",
          points: ["Describe the result"],
          rewrite: null,
          why: "Evidence supports the claim.",
          nextTip: "Practise aloud.",
        };
      if (kind === "chat.reply")
        return {
          text: "Describe an actual project outcome.",
          card: {
            type: "skills",
            title: "Evidence to develop",
            summary: "Start from your work.",
            score: null,
            items: [
              {
                label: "Projects",
                description: "Explain a measurable outcome",
                status: "Suggested",
              },
            ],
            actions: ["Practise a project answer"],
          },
        };
      if (kind === "career.analyze")
        return {
          summary: "A resume-based preparation report.",
          advice: "Add evidence.",
          alignment: null,
          atsHealth: 70,
          bestFit: "Graduate engineer",
          signals: ["Projects"],
          strengths: ["Technical background"],
          weaknesses: ["Outcomes missing"],
          roadmap: [{ phase: "This week", actions: ["Add project outcomes"] }],
          risks: [
            {
              title: "Limited evidence",
              severity: "medium",
              mitigation: "Quantify your work",
            },
          ],
          roles: [
            {
              title: "Graduate engineer",
              fit: null,
              reason: "Based on the supplied projects",
            },
          ],
          recommendations: ["Tailor to each JD"],
          missingKeywords: ["Testing"],
          formattingIssues: [],
          profile: { academics: [], skills: ["JavaScript"], projects: ["Campus API"], achievements: [] },
        };
      if (kind === "readiness.plan")
        return {
          title: "Prepare with evidence",
          actions: [
            {
              priority: 1,
              title: "Practice projects",
              reason: "Build a baseline",
              practice: "Explain one actual project",
            },
          ],
        };
      if (kind === "assessment.generate")
        return { title: "Role preparation", questions: [sampleQuestion] };
      if (kind === "assessment.evaluate") {
        if (failEvaluation) throw Error("simulated provider outage");
        return {
          results: input.questions.map((q) => ({
            id: q.id,
            score: q.maximum / 2,
            feedback: "Add a concrete example.",
          })),
        };
      }
      throw Error("Unexpected AI request " + kind);
    };
    const app = await buildApp({
      pool,
      env: {
        SERVICE_TOKEN: "x".repeat(32),
        RATE_LIMIT_USER_MAX: 10000,
        ASSESSMENT_CODE_SECRET: "c".repeat(32),
      },
      logger: false,
      verify: async (token) => ({ id: users[token] }),
      studentAi: ai,
    });
    t.after(() => app.close());
    async function request(path, body, user = "a", expected = 200) {
      const response = await app.inject({
        url: "/api/v1" + path,
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer " + user },
        payload: body,
      });
      assert.equal(response.statusCode, expected, path + ": " + response.body);
      return response.json().data;
    }
    let conversation, plan, session, assigned, code, attempt;
    await t.test(
      "profile conflicts, upload ownership, resume reports and persistent chat",
      async () => {
        await request("/student/profile", {
          details: { fullName: "Student A" },
          revision: 0,
          complete: true,
        });
        await request(
          "/student/profile",
          { details: { fullName: "Old tab" }, revision: 0 },
          "a",
          409,
        );
        await request(
          "/student/profile",
          {
            details: { fullName: "Student A", linkedin: "bad URL" },
            revision: 1,
          },
          "a",
          400,
        );
        const resume =
          "Student projects: developed a campus API using JavaScript and PostgreSQL, tested authorization and documented the deployment process.";
        const document = await request("/student/documents", {
          filename: "resume.txt",
          kind: "resume",
          data: Buffer.from(resume).toString("base64"),
        });
        assert.equal(document.content, resume);
        const report = await request("/student/career", {
          resume,
          target: "Graduate engineer",
          consent: true,
        });
        assert.equal(report.content.alignment, null);
        assert.equal((await request("/student/career")).report.id, report.id);
        assert.equal(
          (await request("/student/career", undefined, "b")).report,
          null,
        );
        conversation = await request("/student/conversations", {});
        await request(
          "/student/conversations/" + conversation.id + "/message",
          { message: "Help with my projects", documentId: document.id },
        );
        const chat = await request("/student/conversations/" + conversation.id);
        assert.equal(chat.messages.length, 2);
        assert.equal(chat.messages[1].card.type, "skills");
        await request(
          "/student/conversations/" + conversation.id,
          undefined,
          "b",
          404,
        );
        const otherChat = await request("/student/conversations", {}, "b");
        await request(
          "/student/conversations/" + otherChat.id + "/message",
          { message: "Read a document", documentId: document.id },
          "b",
          404,
        );
        assert.equal(
          (await request("/student/readiness/plan", {})).actions.length,
          1,
        );
      },
    );
    const config = {
      durationMinutes: 5,
      language: "en-IN",
      tone: "friendly",
      depth: "moderate",
      questionCount: 3,
    };
    await t.test(
      "interview answer order, retry, provider recovery, coaching and private reports",
      async () => {
        plan = await request("/student/interviews", {
          source: "manual",
          goal: "Prepare for a graduate engineer role",
          config,
          manualQuestions: [
            "Describe your project.",
            "Tell us about teamwork.",
            "How did you test it?",
          ],
        });
        session = await request(
          "/student/interviews/" + plan.id + "/sessions",
          { mode: "mock", accepted: true },
        );
        assert.equal(
          (await request("/student/sessions/" + session.id)).currentIndex,
          0,
        );
        await request(
          "/student/sessions/" + session.id + "/answer",
          { questionIndex: 2, answer: "Skipping to another question" },
          "a",
          409,
        );
        await request(
          "/student/sessions/" + session.id + "/coach",
          { questionIndex: 0, action: "Ideal Answer" },
          "a",
          403,
        );
        await request("/student/sessions/" + session.id + "/answer", {
          questionIndex: 0,
          answer: "I built an API and tested the access controls.",
        });
        failEvaluation = true;
        await request(
          "/student/sessions/" + session.id + "/answer",
          {
            questionIndex: 0,
            answer: "I built an API with ten meaningful access control tests.",
            retry: true,
          },
          "a",
          503,
        );
        failEvaluation = false;
        await request("/student/sessions/" + session.id + "/answer", {
          questionIndex: 0,
          answer: "I built an API with ten meaningful access control tests.",
          retry: true,
        });
        await request(
          "/student/sessions/" + session.id + "/answer",
          { questionIndex: 0, answer: "Another retry", retry: true },
          "a",
          409,
        );
        failEvaluation = true;
        await request(
          "/student/sessions/" + session.id + "/answer",
          {
            questionIndex: 1,
            answer: "I worked with a teammate and reviewed changes.",
          },
          "a",
          503,
        );
        const ended = await request(
          "/student/sessions/" + session.id + "/finish",
          {},
        );
        assert.equal(ended.report.pending, 1);
        failEvaluation = false;
        assert.equal(
          (await request("/student/sessions/" + session.id + "/evaluate", {}))
            .report.pending,
          0,
        );
        assert.equal(
          (
            await request("/student/sessions/" + session.id + "/coach", {
              questionIndex: 0,
              action: "STAR Version",
            })
          ).rewrite,
          null,
        );
        await request("/student/sessions/" + session.id, undefined, "b", 404);
        const d = await request("/student/dashboard"),
          r = await request("/student/readiness");
        assert.equal(d.score, 70);
        assert.equal(d.score, r.score);
        assert.equal(
          (await request("/student/interviews/stats")).sessions.completed,
          1,
        );
      },
    );
    await t.test(
      "proctored mode withholds feedback and ends after three distinct browser warnings",
      async () => {
        const generated = await request("/student/interviews", {
          source: "ai",
          goal: "Graduate engineer role",
          config,
        });
        const s = await request(
          "/student/interviews/" + generated.id + "/sessions",
          { mode: "proctored", accepted: true },
        );
        const live = await request("/student/sessions/" + s.id);
        assert.deepEqual(live.answers, []);
        assert.equal(live.questions, undefined);
        assert.equal(live.report, null);
        const answer = await request("/student/sessions/" + s.id + "/answer", {
          questionIndex: 0,
          answer: "I shipped a tested application.",
        });
        assert.equal(answer.feedback, null);
        const conversation = await request("/student/sessions/" + s.id);
        assert.equal(conversation.answers[0].answer, "I shipped a tested application.");
        assert.ok(conversation.answers[0].question);
        assert.deepEqual(conversation.answers[0].feedback, {});
        assert.equal(conversation.answers[0].original_feedback, null);
        assert.equal(conversation.answers[0].coaching, undefined);
        assert.equal(conversation.report, null);
        for (const kind of ["tab-hidden", "screen-stopped", "fullscreen-exit"])
          await request("/student/sessions/" + s.id + "/integrity", { kind });
        const result = await request("/student/sessions/" + s.id);
        assert.equal(result.status, "terminated");
        assert.equal(result.answers.length, 1);
      },
    );
    await t.test(
      "AI tests hide answer keys, autosave with revisions and preserve deadlines",
      async () => {
        const paper = await request("/student/assessments/generate", {
          source: "topics",
          context: "Basic numerical reasoning",
          sections: [{ name: "Reasoning", count: 1, type: "mcq" }],
          difficulty: "easy",
          durationMinutes: 5,
          fullscreen: false,
        });
        const started = await request(
          "/student/assessments/" + paper.id + "/start",
          { accepted: true },
        );
        attempt = started.id;
        const live = await request("/student/attempts/" + attempt);
        assert.equal(live.questions[0].correctIndex, undefined);
        assert.equal(live.questions[0].expectedPoints, undefined);
        assert.equal(live.identity.usn, "ST000");
        const resumed = await request(
          "/student/assessments/" + paper.id + "/start",
          { accepted: true },
        );
        assert.equal(resumed.id, attempt);
        await request("/student/attempts/" + attempt + "/save", {
          answers: { q1: "1" },
          marked: ["q1"],
          revision: 1,
        });
        await request(
          "/student/attempts/" + attempt + "/save",
          { answers: { q1: "0" }, marked: [], revision: 1 },
          "a",
          409,
        );
        await request("/student/attempts/" + attempt, undefined, "b", 404);
        await db.query(
          "UPDATE student.attempts SET expires_at=now()-interval '1 second' WHERE id=$1",
          [attempt],
        );
        await request(
          "/student/attempts/" + attempt + "/save",
          { answers: { q1: "0" }, marked: [], revision: 2 },
          "a",
          409,
        );
        const score = await request(
          "/student/attempts/" + attempt + "/submit",
          { answers: { q1: "0" } },
        );
        assert.equal(score.percentage, 100);
        assert.equal(score.review[0].answer, "1");
        assert.equal(
          (
            await request("/student/attempts/" + attempt + "/submit", {
              answers: { q1: "0" },
            })
          ).percentage,
          100,
        );
      },
    );
    await t.test(
      "practice levels unlock from earned results and every question has a valid distinct key",
      async () => {
        for (const category of Object.keys(CATEGORIES))
          for (let level = 1; level <= 5; level++) {
            const qs = practiceQuestions(category, level);
            assert.ok(qs.length > 0);
            for (const q of qs) {
              if (q.type === "short") {
                // Written practice items are graded against expected points.
                assert.ok(q.expectedPoints.length > 0);
                assert.equal(q.correctIndex, null);
                continue;
              }
              assert.ok(
                q.correctIndex >= 0 && q.correctIndex < q.options.length,
              );
              assert.equal(new Set(q.options).size, q.options.length);
            }
          }
        await request("/student/practice/aptitude/2", {}, "a", 409);
        const paper = await request("/student/practice/aptitude/1", {}),
          started = await request(
            "/student/assessments/" + paper.id + "/start",
            { accepted: true },
          );
        const key = (
          await db.query(
            "SELECT questions FROM student.assessments WHERE id=$1",
            [paper.id],
          )
        ).rows[0].questions;
        await request("/student/attempts/" + started.id + "/submit", {
          answers: Object.fromEntries(
            key.map((q) => [q.id, String(q.correctIndex)]),
          ),
        });
        assert.ok((await request("/student/practice/aptitude/2", {})).id);
      },
    );
    await t.test(
      "only officers publish assigned tests; codes, cohort, schedule and evaluation recovery are enforced",
      async () => {
        const body = {
          title: "Assigned placement test",
          className: "Graduate cohort",
          portions: "Reasoning and evidence",
          questions: [
            sampleQuestion,
            {
              ...sampleQuestion,
              type: "short",
              question: "Explain a project outcome.",
              options: [],
              correctIndex: null,
              expectedPoints: ["Outcome evidence"],
            },
          ],
          batch: "2028",
          opensAt: new Date(Date.now() - 60000).toISOString(),
          closesAt: new Date(Date.now() + 3600000).toISOString(),
          durationMinutes: 30,
          proctored: true,
          published: true,
        };
        await request("/placement/tools/assessments", body, "a", 403);
        assigned = await request(
          "/placement/tools/assessments",
          body,
          "officer",
        );
        code = assigned.code;
        assert.match(code, /^\d{6}$/);
        await request("/student/assigned/unlock", { code }, "b", 404);
        await request(
          "/student/assessments/" + assigned.id + "/start",
          { accepted: true },
          "a",
          403,
        );
        assert.equal(
          (await request("/student/assigned/unlock", { code })).id,
          assigned.id,
        );
        const started = await request(
          "/student/assessments/" + assigned.id + "/start",
          { code, accepted: true },
        );
        await request("/student/attempts/" + started.id + "/integrity", {
          kind: "clipboard",
        });
        failEvaluation = true;
        await request(
          "/student/attempts/" + started.id + "/submit",
          { answers: { q1: "1", q2: "The project reduced manual work." } },
          "a",
          503,
        );
        assert.equal(
          (await request("/student/attempts/" + started.id)).status,
          "submitted",
        );
        failEvaluation = false;
        assert.equal(
          (await request("/student/attempts/" + started.id + "/evaluate", {}))
            .percentage,
          75,
        );
        await request(
          "/student/assessments/" + assigned.id + "/start",
          { accepted: true, code },
          "a",
          409,
        );
        await request(
          "/placement/tools/assessments/" + assigned.id + "/publication",
          { published: false },
          "officer",
        );
        assert.equal(
          (await request("/student/attempts/" + started.id)).status,
          "completed",
        );
        const results = await request(
          "/placement/tools/assessments/" + assigned.id + "/results",
          undefined,
          "officer",
        );
        assert.equal(results[0].identity.usn, "ST000");
        assert.equal(results[0].integrity.length, 1);
        await request(
          "/placement/tools/assessments/" + assigned.id + "/results",
          undefined,
          "a",
          403,
        );
      },
    );
    await t.test(
      "large written assessments save grading progress across provider failures",
      async () => {
        const questions = Array.from({ length: 11 }, (_, index) => ({
          ...sampleQuestion,
          type: "short",
          question: `Explain project outcome ${index + 1}.`,
          options: [],
          correctIndex: null,
          expectedPoints: ["Evidence"],
        }));
        const paper = await request(
          "/placement/tools/assessments",
          {
            title: "Long written assessment",
            className: "Graduate cohort",
            portions: "Evidence",
            questions,
            batch: "2028",
            opensAt: new Date(Date.now() - 60000).toISOString(),
            closesAt: new Date(Date.now() + 3600000).toISOString(),
            durationMinutes: 30,
            proctored: false,
            published: true,
          },
          "officer",
        );
        const attempt = await request(
          `/student/assessments/${paper.id}/start`,
          { accepted: true, code: paper.code },
        );
        const pending = await request(
          `/student/attempts/${attempt.id}/submit`,
          {
            answers: Object.fromEntries(
              questions.map((_, i) => [
                "q" + (i + 1),
                "A concrete measured outcome.",
              ]),
            ),
          },
        );
        assert.deepEqual(pending, { pending: true, graded: 5, total: 11 });
        failEvaluation = true;
        await request(`/student/attempts/${attempt.id}/evaluate`, {}, "a", 503);
        assert.equal(
          Object.keys(
            (await request(`/student/attempts/${attempt.id}`)).grading,
          ).length,
          5,
        );
        failEvaluation = false;
        assert.deepEqual(
          await request(`/student/attempts/${attempt.id}/evaluate`, {}),
          { pending: true, graded: 10, total: 11 },
        );
        const result = await request(
          `/student/attempts/${attempt.id}/evaluate`,
          {},
        );
        assert.equal(result.percentage, 50);
        assert.equal(result.review.length, 11);
        assert.deepEqual(
          await request(`/student/attempts/${attempt.id}/evaluate`, {}),
          result,
        );
      },
    );
    await t.test(
      "published opportunities obey cohort and eligibility; applications are real and withdrawable",
      async () => {
        const company = randomUUID(),
          drive = randomUUID(),
          hidden = randomUUID();
        await db.query(
          "INSERT INTO placement.companies(id,name) VALUES($1,'Test employer')",
          [company],
        );
        for (const [id, published] of [
          [drive, true],
          [hidden, false],
        ])
          await db.query(
            "INSERT INTO placement.drives(id,company_id,title,description,package_lpa,academic_year,batch,rounds,published,skills,location) VALUES($1,$2,'Graduate engineer','Role description',8,'2028-29','2028',ARRAY['Interview'],$3,'PostgreSQL','Bengaluru')",
            [id, company, published],
          );
        assert.equal(
          (await request("/student/opportunities?search=PostgreSQL")).total,
          1,
        );
        assert.equal(
          (await request("/student/opportunities", undefined, "b")).total,
          0,
        );
        await request("/student/opportunities/" + hidden, undefined, "a", 404);
        const registration = await request(
          "/student/opportunities/" + drive + "/apply",
          { confirmed: true },
        );
        assert.equal(registration.status, "registered");
        assert.equal(
          (await request("/student/opportunities/" + drive)).application.id,
          registration.id,
        );
        await request("/student/opportunities/" + drive + "/withdraw", {
          confirmed: true,
        });
        assert.equal(
          (await request("/student/opportunities/" + drive)).application.status,
          "withdrawn",
        );
      },
    );
    await t.test(
      "personal calendar, officer cohort broadcasts and read receipts remain isolated",
      async () => {
        const event = {
          title: "Focused preparation",
          kind: "practice",
          startsAt: new Date(Date.now() + 3600000).toISOString(),
          endsAt: new Date(Date.now() + 7200000).toISOString(),
          location: "Library",
          description: "Review projects",
        };
        const personal = await request("/student/calendar", event);
        await request(
          "/placement/tools/events",
          {
            event: { ...event, title: "Cohort mentoring" },
            batch: "2028",
            notify: true,
          },
          "officer",
        );
        await request(
          "/placement/tools/notices",
          {
            title: "Prepare your resume",
            body: "Bring your latest resume.",
            batch: "2028",
          },
          "officer",
        );
        assert.equal((await request("/student/calendar")).length, 2);
        assert.equal(
          (await request("/student/calendar", undefined, "b")).length,
          0,
        );
        // Two published assessments, the cohort event, the explicit notice and
        // the eligible-drive notice from the published opportunity above.
        assert.equal((await request("/student/notifications")).length, 5);
        assert.equal(
          (await request("/student/notifications", undefined, "b")).length,
          0,
        );
        await request("/student/notifications/read", {});
        assert.ok(
          (await request("/student/notifications")).every((n) => n.read_at),
        );
        await request("/student/calendar/" + personal.id + "/delete", {}, "b");
        assert.equal((await request("/student/calendar")).length, 2);
        await request("/student/calendar/" + personal.id + "/delete", {});
        assert.equal((await request("/student/calendar")).length, 1);
        assert.ok(
          (await request("/student/dashboard")).notifications.length >= 2,
        );
        await request("/student/conversations/clear", { confirmed: true });
        assert.equal((await request("/student/conversations")).length, 0);
      },
    );
  },
);
