// Registers the DSU skills GitHub App with GitHub's app-manifest flow and
// writes its client credentials into .env. The person running it signs in to
// GitHub in their own browser and clicks "Create GitHub App"; nothing here
// sees their GitHub password.
//
//   node scripts/register-github-app.js [--web http://localhost:3000] [--port 4199] [--env .env]
//
// Writes GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG and
// GITHUB_OAUTH_REDIRECT_URL. Secrets are never printed. The app's private key
// is not needed (only user authorization is used) and is discarded.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const web = arg("web", "http://localhost:3000").replace(/\/$/, "");
const port = Number(arg("port", "4199"));
const envFile = arg("env", ".env");
const state = randomBytes(16).toString("hex");
const callback = `${web}/student/connections/github/callback`;

const manifest = {
  name: `DSU ERP Skills ${randomBytes(2).toString("hex")}`,
  url: web,
  description: "Reads a student's public GitHub profile and repositories for the DSU ERP skills profile and Students Ranking.",
  redirect_url: `http://localhost:${port}/created`,
  callback_urls: [callback],
  request_oauth_on_install: false,
  public: true,
  // Public data only: no repository or organization permissions are requested.
  default_permissions: {},
  hook_attributes: { url: "https://example.invalid/github-webhook", active: false },
};

const page = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Register GitHub App</title>
  <style>body{font:15px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1b211b}
  button{font:inherit;padding:.6rem 1rem;border:1px solid #34462f;background:#34462f;color:#fff;border-radius:.3rem;cursor:pointer}
  code{background:#eef1e9;padding:.1rem .3rem;border-radius:.2rem}</style></head><body>${body}</body></html>`;

function writeEnv(values) {
  let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\s*$/, "")}${eol}${line}${eol}`;
  }
  writeFileSync(envFile, text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/") {
    res.end(page(`<h1>Register the DSU skills GitHub App</h1>
      <p>This creates a GitHub App on your GitHub account. It requests no repository permissions and only reads public profile data after a student authorizes it.</p>
      <p>Student callback: <code>${callback}</code></p>
      <form action="https://github.com/settings/apps/new?state=${state}" method="post">
        <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
        <button>Continue to GitHub</button>
      </form>
      <p>On GitHub, review the name (change it if it is taken) and choose <strong>Create GitHub App</strong>.</p>`));
    return;
  }
  if (url.pathname === "/created") {
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || !/^[A-Za-z0-9_-]{1,100}$/.test(code || "")) {
      res.statusCode = 400;
      res.end(page("<h1>Invalid response</h1><p>The state did not match. Start again from the first page.</p>"));
      return;
    }
    try {
      const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      });
      const app = await response.json();
      if (!response.ok || !app.client_id || !app.client_secret) throw new Error(`GitHub returned ${response.status}`);
      writeEnv({
        GITHUB_APP_CLIENT_ID: app.client_id,
        GITHUB_APP_CLIENT_SECRET: app.client_secret,
        GITHUB_APP_SLUG: app.slug,
        GITHUB_OAUTH_REDIRECT_URL: callback,
      });
      res.end(page(`<h1>GitHub App created</h1><p><strong>${app.name}</strong> (<code>${app.slug}</code>) is registered and its credentials are saved in <code>${envFile}</code>.</p>
        <p>Restart the backend to use it. You can close this tab.</p>`));
      console.log(JSON.stringify({ event: "github_app_registered", slug: app.slug, id: app.id, envFile, callback }));
      setTimeout(() => server.close(), 500);
    } catch (error) {
      res.statusCode = 502;
      res.end(page(`<h1>Registration did not finish</h1><p>${String(error.message).replace(/[<>&]/g, "")}. Start again from the first page.</p>`));
      console.error(JSON.stringify({ event: "github_app_registration_failed", message: error.message }));
    }
    return;
  }
  res.statusCode = 404;
  res.end(page("<p>Not found.</p>"));
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "github_app_registration_ready", open: `http://localhost:${port}/`, callback }));
});
