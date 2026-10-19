import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { z } from "zod";
import { runStudent } from "./context.js";
import { httpError } from "../../platform/http/errors.js";
let active = 0;
export function registerDocumentRoutes(api, { pool }) {
  api.post(
    "/student/documents",
    {
      bodyLimit: 15 * 1024 * 1024,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req) => {
      const input = z
        .object({
          filename: z
            .string()
            .max(200)
            .regex(/\.(pdf|docx|txt|md)$/i),
          kind: z.enum(["resume", "jd", "attachment"]),
          data: z.string().max(14 * 1024 * 1024),
        })
        .strict()
        .parse(req.body);
      await runStudent(pool, req.actor.id, async () => {});
      const buffer = Buffer.from(input.data, "base64");
      if (!buffer.length || buffer.length > 10 * 1024 * 1024)
        throw httpError(
          413,
          "FILE_TOO_LARGE",
          "Choose a file of 10 MB or less.",
        );
      if (active >= 2)
        throw httpError(
          429,
          "UPLOAD_BUSY",
          "Document processing is busy. Please try again shortly.",
        );
      active++;
      let content;
      try {
        content = await new Promise((resolve, reject) => {
          const worker = new Worker(
            new URL("./document-worker.js", import.meta.url),
            {
              workerData: { filename: input.filename, data: buffer },
              resourceLimits: { maxOldGenerationSizeMb: 256 },
            },
          );
          const timeout = setTimeout(() => {
            void worker.terminate();
            reject(new Error("timeout"));
          }, 15000);
          worker.once("message", (value) => {
            clearTimeout(timeout);
            void worker.terminate();
            value.error ? reject(new Error(value.error)) : resolve(value.text);
          });
          worker.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          worker.once("exit", (code) => {
            clearTimeout(timeout);
            if (code !== 0) reject(new Error("document worker stopped"));
          });
        });
      } catch {
        throw httpError(
          400,
          "DOCUMENT_UNREADABLE",
          "This file could not be read. Try an unlocked document or paste its text.",
        );
      } finally {
        active--;
      }
      if (!content?.trim())
        throw httpError(
          400,
          "NO_TEXT",
          "No readable text was found. Paste text from a scanned or protected document.",
        );
      return runStudent(pool, req.actor.id, async (client) => {
        const { rows } = await client.query(
          "INSERT INTO student.documents(user_id,filename,kind,content,sha256) VALUES($1,$2,$3,$4,$5) RETURNING id,filename,kind,content,created_at",
          [
            req.actor.id,
            input.filename,
            input.kind,
            content.slice(0, 80000),
            createHash("sha256").update(buffer).digest("hex"),
          ],
        );
        return { data: rows[0] };
      });
    },
  );
}
