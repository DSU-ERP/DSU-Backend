import { buildApp } from "./app.js";
try {
  const app = await buildApp();
  process.on("SIGTERM", () => void app.close());
  process.on("SIGINT", () => void app.close());
  await app.listen({ port: Number(process.env.PORT || 4000), host: "0.0.0.0" });
} catch {
  console.error(
    "Backend startup failed: check required environment configuration.",
  );
  process.exitCode = 1;
}
