import { registerAssessmentRoutes } from "./assessments.js";
import { registerInterviewRoutes } from "./interviews.js";
import { registerChatRoutes } from "./chat.js";
import { registerCalendarRoutes } from "./calendar.js";
import { registerOpportunityRoutes } from "./opportunities.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerCareerRoutes } from "./career.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerProfileRoutes } from "./profile.js";
import { withActor } from "../../integrations/supabase/db.js";
import { httpError, databaseError } from "../../platform/http/errors.js";
export function registerStudentRoutes(api, { pool, generate, env }) {
  registerDashboardRoutes(api, { pool, generate });
  registerCareerRoutes(api, { pool, generate });
  registerDocumentRoutes(api, { pool, generate });
  registerOpportunityRoutes(api, { pool, generate });
  registerCalendarRoutes(api, { pool, generate });
  registerChatRoutes(api, { pool, generate });
  registerInterviewRoutes(api, { pool, generate });
  registerAssessmentRoutes(api, { pool, generate, env });
  registerProfileRoutes(api, { pool });
  // The verified identity chooses the record. A caller cannot supply a student ID.
  api.get("/student/me", async (req) =>
    withActor(pool, req.actor.id, async (client) => {
      const { rows } = await client.query(
        "SELECT student_id FROM erp.memberships WHERE user_id=$1 AND role='student'",
        [req.actor.id],
      );
      if (!rows[0]?.student_id)
        throw httpError(
          403,
          "STUDENT_ACCESS_REQUIRED",
          "Your administrator needs to link your student account.",
        );
      try {
        const result = await client.query(
          "SELECT public.dsu_portal_read($1,'{}'::jsonb) AS result",
          [`/students/${rows[0].student_id}`],
        );
        return result.rows[0].result;
      } catch (error) {
        throw databaseError(error);
      }
    }),
  );
}
