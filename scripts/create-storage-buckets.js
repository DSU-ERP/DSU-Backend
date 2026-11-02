// Creates the private Supabase Storage buckets for company JD PDFs and student
// resumes (docs/COMPANY-PORTAL.md). Safe to re-run: existing private buckets
// are left as they are, and a public bucket with the same name is refused.
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env; prints no secrets.
import { createStorage } from "../src/modules/files/storage.js";

const storage = createStorage(process.env);
if (!storage.configured) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in DSU-Backend/.env first.");
  process.exit(1);
}
try {
  const created = await storage.ensureBuckets();
  console.log(created.length ? `Created private buckets: ${created.join(", ")}` : "Private buckets already exist: drive-documents, resumes");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
