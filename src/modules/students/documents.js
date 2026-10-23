import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { runStudent } from "./context.js";
import { httpError } from "../../platform/http/errors.js";
export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
let active = 0;

/** Decodes a base64 upload and enforces the 10 MB limit. */
export function decodeUpload(data) {
  const buffer = Buffer.from(data, "base64");
  if (!buffer.length || buffer.length > UPLOAD_LIMIT_BYTES)
    throw httpError(413, "FILE_TOO_LARGE", "Choose a file of 10 MB or less.");
  return buffer;
}

const LIMIT_ERRORS = {
  TOO_MANY_PAGES: [
    "TOO_MANY_PAGES",
    "This PDF has more than 100 pages. Upload a shorter document or paste the relevant text.",
  ],
  DOCUMENT_TOO_LARGE: [
    "DOCUMENT_TOO_LARGE",
    "This document expands to more than 20 MB. Upload a smaller file or paste the relevant text.",
  ],
};

/**
 * Native PDF dependencies can crash during worker-thread teardown on Windows.
 * A separate process contains those failures so an upload cannot take down the
 * API. Keep the same 15 s / two-at-a-time limits, with a bounded child heap.
 */
export async function extractDocument(filename, buffer) {
  if (active >= 2)
    throw httpError(
      429,
      "UPLOAD_BUSY",
      "Document processing is busy. Please try again shortly.",
    );
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const workerEnv = { ...process.env };
      // `node --watch` injects this flag. Inherited by a fork, it emits module
      // dependency reports over IPC before the document result arrives.
      delete workerEnv.WATCH_REPORT_DEPENDENCIES;
      const worker = fork(
        new URL("./document-worker.js", import.meta.url),
        [],
        {
          execArgv: ["--max-old-space-size=256"],
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          env: workerEnv,
        },
      );
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.kill();
        error ? reject(error) : resolve(value);
      };
      const timeout = setTimeout(() => finish(new Error("timeout")), 15000);
      worker.on("message", (message) => {
        if (message?.type !== "document:result") return;
        const value = message.result;
        if (!value || typeof value !== "object")
          return finish(new Error("invalid extraction response"));
        if (!value.error && typeof value.content !== "string")
          return finish(new Error("invalid extraction content"));
        finish(value.error ? new Error(value.error) : null, value);
      });
      worker.once("error", (error) => finish(error));
      worker.once("exit", () => {
        finish(new Error("document process stopped"));
      });
      worker.send({ filename, data: buffer }, (error) => {
        if (error) finish(error);
      });
    });
  } catch (error) {
    if (Object.hasOwn(LIMIT_ERRORS, String(error?.message)))
      throw httpError(413, ...LIMIT_ERRORS[error.message]);
    throw httpError(
      400,
      "DOCUMENT_UNREADABLE",
      "This file could not be read. Try an unlocked document or paste its text.",
    );
  } finally {
    active--;
  }
}

export function registerDocumentRoutes(api, { pool }) {
  api.get("/student/documents", async (req) =>
    runStudent(pool, req.actor.id, async (client) => {
      const { rows } = await client.query(
        "SELECT id,filename,kind,created_at,meta FROM student.documents WHERE user_id=$1 ORDER BY created_at DESC,id DESC",
        [req.actor.id],
      );
      return {
        data: rows.map((row) => ({
          ...row,
          // Extracted text may contain sensitive personal information. The
          // settings screen only needs document metadata to show uploads.
          pageCount: row.meta?.pageCount ?? null,
        })),
      };
    }),
  );
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
      const buffer = decodeUpload(input.data);
      const extracted = await extractDocument(input.filename, buffer);
      if (!extracted.content.trim())
        throw httpError(
          400,
          "NO_TEXT",
          "No readable text was found. Paste text from a scanned or protected document.",
        );
      const meta = {
        pageCount: extracted.pageCount,
        chars: extracted.chars,
        truncated: extracted.truncated,
        lowText: extracted.lowText,
      };
      return runStudent(pool, req.actor.id, async (client) => {
        const { rows } = await client.query(
          "INSERT INTO student.documents(user_id,filename,kind,content,sha256,meta) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,filename,kind,content,created_at",
          [
            req.actor.id,
            input.filename,
            input.kind,
            extracted.content,
            createHash("sha256").update(buffer).digest("hex"),
            JSON.stringify(meta),
          ],
        );
        return { data: { ...rows[0], ...meta } };
      });
    },
  );
}
