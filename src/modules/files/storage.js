// Private file storage (Supabase Storage). Only the backend holds the service
// key. Access is decided in SQL (files.can_read) before any link is signed, and
// links expire after SIGNED_URL_SECONDS. Postgres keeps metadata, never bytes.
import { createHash, randomUUID } from "node:crypto";
import { httpError } from "../../platform/http/errors.js";

export const BUCKETS = Object.freeze({
  "drive-documents": { fileSizeLimit: 10 * 1024 * 1024 },
  resumes: { fileSizeLimit: 10 * 1024 * 1024 },
});
export const SIGNED_URL_SECONDS = 300;
export const PDF_LIMIT_BYTES = 10 * 1024 * 1024;

/** Validates a base64 PDF upload: size, magic bytes and a sane filename. */
export function readPdf(filename, data) {
  const buffer = Buffer.from(String(data || ""), "base64");
  if (!buffer.length) throw httpError(400, "EMPTY_FILE", "Choose a PDF file.");
  if (buffer.length > PDF_LIMIT_BYTES)
    throw httpError(413, "FILE_TOO_LARGE", "Choose a PDF of 10 MB or less.");
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw httpError(400, "INVALID_FILE_TYPE", "Only PDF files can be uploaded.");
  const name = String(filename || "document.pdf")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim()
    .slice(0, 200) || "document.pdf";
  return {
    buffer,
    filename: /\.pdf$/i.test(name) ? name : `${name}.pdf`,
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

/** Object path inside a bucket. Owner ids are UUIDs; the file id is random. */
export function objectPath(kind, ownerId, fileId = randomUUID()) {
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) throw new Error("Invalid owner id");
  return { id: fileId, path: `${kind}/${ownerId}/${fileId}.pdf` };
}

const unavailable = () =>
  httpError(
    503,
    "FILE_STORAGE_UNAVAILABLE",
    "File storage is not configured on this server yet. Ask the administrator to add the storage key.",
  );

/**
 * Supabase Storage REST client. `fetch` is injectable for tests. New-style
 * secret keys (sb_secret_...) go in the apikey header only; legacy JWT service
 * keys are also sent as the bearer token.
 */
export function createStorage(env = process.env, { fetch: request = globalThis.fetch } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const base = env.SUPABASE_URL ? new URL(env.SUPABASE_URL).origin + "/storage/v1" : null;
  const configured = Boolean(key && base);
  const headers = (extra = {}) => ({
    apikey: key,
    ...(key?.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}),
    ...extra,
  });
  const call = async (path, init) => {
    if (!configured) throw unavailable();
    let response;
    try {
      response = await request(base + path, { ...init, signal: AbortSignal.timeout(20000) });
    } catch {
      throw httpError(502, "FILE_STORAGE_UNREACHABLE", "File storage could not be reached. Try again shortly.");
    }
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, ok: response.ok, body };
  };
  const encode = (path) => path.split("/").map(encodeURIComponent).join("/");
  return {
    configured,
    async upload(bucket, path, buffer) {
      if (!BUCKETS[bucket]) throw new Error("Unknown bucket");
      const result = await call(`/object/${bucket}/${encode(path)}`, {
        method: "POST",
        headers: headers({ "content-type": "application/pdf", "x-upsert": "false", "cache-control": "private, max-age=0" }),
        body: buffer,
      });
      if (!result.ok)
        throw httpError(502, "FILE_UPLOAD_FAILED", "The file could not be stored. Try again shortly.");
    },
    async signedUrl(bucket, path, filename) {
      const result = await call(`/object/sign/${bucket}/${encode(path)}`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }),
      });
      const signed = result.body?.signedURL || result.body?.signedUrl;
      if (!result.ok || typeof signed !== "string")
        throw httpError(502, "FILE_LINK_FAILED", "A download link could not be created. Try again shortly.");
      const url = new URL(base + signed);
      if (filename) url.searchParams.set("download", filename);
      return { url: url.toString(), expiresIn: SIGNED_URL_SECONDS };
    },
    async remove(bucket, path) {
      if (!configured) return;
      await call(`/object/${bucket}`, {
        method: "DELETE",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: [path] }),
      }).catch(() => {});
    },
    /** Creates the private buckets when missing (scripts/create-storage-buckets.js). */
    async ensureBuckets() {
      const created = [];
      for (const [id, options] of Object.entries(BUCKETS)) {
        const existing = await call(`/bucket/${id}`, { method: "GET", headers: headers() });
        if (existing.ok) {
          if (existing.body?.public) throw new Error(`Bucket ${id} is public. Make it private in Supabase first.`);
          continue;
        }
        const result = await call("/bucket", {
          method: "POST",
          headers: headers({ "content-type": "application/json" }),
          body: JSON.stringify({ id, name: id, public: false, file_size_limit: options.fileSizeLimit, allowed_mime_types: ["application/pdf"] }),
        });
        if (!result.ok) throw new Error(`Bucket ${id} could not be created (HTTP ${result.status}).`);
        created.push(id);
      }
      return created;
    },
  };
}

/** Stores a validated PDF and returns its metadata row values. Removes the object if `register` fails. */
export async function storePdf(storage, { bucket, kind, ownerId, file }, register) {
  const { id, path } = objectPath(kind, ownerId);
  await storage.upload(bucket, path, file.buffer);
  try {
    return await register({ id, path, filename: file.filename, size: file.size, sha256: file.sha256 });
  } catch (error) {
    await storage.remove(bucket, path);
    throw error;
  }
}
