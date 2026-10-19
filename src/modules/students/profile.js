import { z } from "zod";
import { runStudent, activity } from "./context.js";
import { httpError } from "../../platform/http/errors.js";

const text = z.string().trim().max(300).default("");
const link = z
  .union([
    z.literal(""),
    z
      .string()
      .url()
      .max(1000)
      .refine((value) =>
        (() => {
          try {
            return ["https:", "http:"].includes(new URL(value).protocol);
          } catch {
            return false;
          }
        })(),
      ),
  ])
  .default("");
export const profileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200),
    phone: text,
    city: text,
    university: text,
    campus: text,
    school: text,
    department: text,
    program: text,
    specialization: text,
    semester: text,
    graduationYear: z
      .string()
      .regex(/^$|^20\d{2}$/)
      .default(""),
    dreamRoles: z.string().max(1000).default(""),
    bio: z.string().max(2000).default(""),
    attendanceGoal: z.number().min(0).max(100).default(85),
    goals: z.array(z.string().max(100)).max(12).default([]),
    voiceStyle: z.enum(["confident", "mentor", "fast"]).default("mentor"),
    focus: text,
    linkedin: link,
    portfolio: link,
    platform: text,
    placementProfile: link,
    certifications: z.string().max(3000).default(""),
    notifications: z.boolean().default(true),
    github: link,
    interests: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    skills: z.string().trim().max(2000).default(''),
    internshipPreference: text,
  })
  .strict();

export function registerProfileRoutes(api, { pool }) {
  api.get("/student/profile", async (req) =>
    runStudent(pool, req.actor.id, async (client, official) => {
      const { rows } = await client.query(
        "SELECT details,onboarded,revision FROM student.profiles WHERE user_id=$1",
        [req.actor.id],
      );
      return {
        data: {
          official,
          details: rows[0]?.details || {},
          onboarded: rows[0]?.onboarded || false,
          revision: rows[0]?.revision || 0,
        },
      };
    }),
  );
  api.post("/student/profile", async (req) => {
    const input = z
      .object({
        details: profileSchema,
        revision: z.number().int().nonnegative(),
        complete: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return runStudent(pool, req.actor.id, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO student.profiles(user_id,details,onboarded)
        SELECT $1,$2,$3 WHERE $4=0 OR EXISTS(SELECT 1 FROM student.profiles WHERE user_id=$1)
        ON CONFLICT(user_id) DO UPDATE SET details=EXCLUDED.details,onboarded=student.profiles.onboarded OR EXCLUDED.onboarded,
        revision=student.profiles.revision+1,updated_at=now() WHERE student.profiles.revision=$4 RETURNING revision,onboarded`,
        [
          req.actor.id,
          JSON.stringify(input.details),
          input.complete,
          input.revision,
        ],
      );
      if (!rows[0])
        throw httpError(
          409,
          "PROFILE_CHANGED",
          "Your profile changed in another window. Reload before saving.",
        );
      await activity(
        client,
        req.actor.id,
        input.complete ? "onboarding.completed" : "profile.updated",
      );
      return { data: rows[0] };
    });
  });
}
