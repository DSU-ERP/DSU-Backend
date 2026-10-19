import { readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
for (const [target, template] of [[".env", ".env.example"], [".env.operator", ".env.operator.example"]]) {
  try { await access(target); console.log(`${target} exists; preserved.`); }
  catch {
    let source = await readFile(template, "utf8");
    if (target === ".env") source = source.replace(/^SERVICE_TOKEN=$/m, `SERVICE_TOKEN=${randomBytes(32).toString("hex")}`).replace(/^ASSESSMENT_CODE_SECRET=$/m, `ASSESSMENT_CODE_SECRET=${randomBytes(32).toString("hex")}`);
    await writeFile(target, source, { flag: "wx", mode: 0o600 });
    console.log(`${target} created. Fill required credentials locally.`);
  }
}
