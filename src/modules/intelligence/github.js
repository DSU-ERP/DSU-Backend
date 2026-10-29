// GitHub integration through the official Octokit SDK ("octokit" package).
// - GitHub App user authorization (web flow) with state and PKCE (S256).
// - Fine-grained personal access token fallback (github_pat_ only).
// - Public profile data only: GraphQL for the profile, repositories, pinned
//   items and contribution calendar; REST stats/contributors for lines added.
// Rate limits are never waited out in-process: the error carries the reset
// time and the sync job is rescheduled. Tokens are never logged or returned.
import { Octokit, OAuthApp } from "octokit";
import { ProviderError } from "./platforms.js";

export { ProviderError };
const API_TIMEOUT_MS = 60000;
const OAUTH_TIMEOUT_MS = 15000;
export const RANKING_NOTE =
  "Suggested ordering only, not an official assessment. Points come from documentation, maintenance and presentation signals; stars and forks do not add points.";
export const STREAK_NOTE = "Counted in UTC from GitHub's contribution calendar (last 12 months).";
export const LANGUAGE_NOTE =
  "Share of code bytes across the student's own public, non-fork repositories. This is repository language share, not proficiency.";
export const LINES_NOTE =
  "Lines added by the student in the last 52 weeks across up to 10 recently pushed own repositories, from GitHub contributor statistics.";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Classifies any Octokit/GraphQL/fetch error into a ProviderError (no token, no URL). */
export function classifyGitHubError(error, now = Date.now()) {
  if (error instanceof ProviderError) return error;
  const status = error?.status ?? error?.response?.status;
  const headers = error?.response?.headers || error?.headers || {};
  const gqlErrors = Array.isArray(error?.errors) ? error.errors : [];
  const resetAt = () => {
    const reset = Number(headers["x-ratelimit-reset"]);
    const retryAfter = Number(headers["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return new Date(now + retryAfter * 1000);
    if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000 + 1000);
    return new Date(now + 60000);
  };
  if (status === 401 || [error?.data?.error, error?.response?.data?.error].includes("bad_refresh_token"))
    return new ProviderError("CREDENTIAL_INVALID", "GitHub rejected the stored credential.", { status });
  if (
    gqlErrors.some((e) => e?.type === "RATE_LIMITED") ||
    ((status === 403 || status === 429) &&
      (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] || /rate limit/i.test(error?.message || "")))
  )
    return new ProviderError("RATE_LIMITED", "GitHub rate limit reached.", { status, retryAt: resetAt() });
  if (status === 404 || (gqlErrors.length && gqlErrors.every((e) => e?.type === "NOT_FOUND")))
    return new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "GitHub account not found.", { status });
  if (status === 403) return new ProviderError("PROVIDER_FORBIDDEN", "GitHub refused the request.", { status });
  return new ProviderError("PROVIDER_UNAVAILABLE", "GitHub is unavailable.", { status });
}

// ---- Pure helpers ------------------------------------------------------------
const DAY = 86400000;
const utcDay = (date) => Math.floor(Date.parse(date + "T00:00:00Z") / DAY);

/** Current streak (ending today or yesterday, UTC), longest streak and active days. */
export function contributionStreaks(days, now = Date.now()) {
  const active = new Set(
    (days || []).filter((d) => d && Number(d.contributionCount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.date)).map((d) => utcDay(d.date)),
  );
  const sorted = [...active].sort((a, b) => a - b);
  let longest = 0;
  let chain = 0;
  let previous;
  for (const day of sorted) {
    chain = previous === day - 1 ? chain + 1 : 1;
    longest = Math.max(longest, chain);
    previous = day;
  }
  const today = Math.floor(now / DAY);
  let current = 0;
  for (let day = active.has(today) ? today : today - 1; active.has(day); day--) current++;
  return { current, longest, activeDays: active.size };
}

/** Language byte share across own non-fork repositories (descending). */
export function languageShare(repositories) {
  const totals = new Map();
  for (const repo of repositories || []) {
    if (repo.isFork) continue;
    for (const [name, bytes] of Object.entries(repo.languages || {}))
      if (Number.isFinite(bytes) && bytes > 0) totals.set(name, (totals.get(name) || 0) + bytes);
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([language, bytes]) => ({ language, bytes, share: sum ? Math.round((bytes / sum) * 1000) / 10 : 0 }));
}

/** Explainable recommendation points. Stars and forks never add points. */
export function scoreRepository(repo, now = Date.now()) {
  const reasons = [];
  let score = 0;
  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };
  if (repo.hasReadme) add(2, "Has a README");
  if (repo.hasReadme && repo.readmeBytes >= 500) add(2, "README is substantial (500+ bytes)");
  if (repo.description) add(1, "Has a description");
  if (repo.topics?.length) add(1, "Has topics");
  if (repo.license) add(1, "Has a license");
  const pushed = repo.pushedAt ? Date.parse(repo.pushedAt) : NaN;
  if (Number.isFinite(pushed)) {
    const age = (now - pushed) / DAY;
    if (age <= 90) add(3, "Updated in the last 90 days");
    else if (age <= 180) add(2, "Updated in the last 180 days");
    else if (age <= 365) add(1, "Updated in the last year");
  }
  if (!repo.isArchived) add(1, "Not archived");
  if (repo.homepage) add(1, "Has a homepage or demo link");
  if (Object.keys(repo.languages || {}).length >= 2) add(1, "Uses more than one language");
  return { score, reasons };
}

const str = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const httpsUrl = (value) => {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
};

// Root-level names that are observable evidence for the ranking rubric. Only
// names are read (never file contents), so this is cheap and bounded.
const MANIFESTS = new Set(["package.json", "requirements.txt", "pyproject.toml", "setup.py", "pipfile", "environment.yml",
  "pom.xml", "build.gradle", "build.gradle.kts", "cargo.toml", "go.mod", "cmakelists.txt", "makefile", "composer.json",
  "gemfile", "pubspec.yaml", "platformio.ini", "package.xml", "mix.exs", "deno.json", "build.sbt"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "testing", "e2e"]);
const TEST_FILE = /(^test_.+\.py$|_test\.(go|py)$|\.(test|spec)\.[cm]?[jt]sx?$|^jest\.config\.|^vitest\.config\.|^pytest\.ini$|^tox\.ini$|^phpunit\.xml)/i;
const SOURCE_DIRS = new Set(["src", "lib", "app", "pkg", "cmd", "internal", "server", "client", "backend", "frontend", "api", "core",
  "components", "modules", "include", "firmware", "scripts", "notebooks", "models"]);
const CI_FILES = new Set([".gitlab-ci.yml", ".travis.yml", "jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml"]);
const DOCKER_FILES = new Set(["dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]);

/**
 * Structural evidence from the repository's root listing and workflows.
 * observed=false when the tree could not be read (empty repository or no
 * default branch): absence of evidence, never evidence of absence.
 */
export function repositoryEvidence(node) {
  const entries = node?.rootTree?.entries;
  const workflows = node?.workflows?.entries;
  const ownerType = ["Organization", "User"].includes(node?.owner?.__typename) ? node.owner.__typename : null;
  if (!Array.isArray(entries)) return { observed: false, ownerType, releases: int(node?.releases?.totalCount), diskKb: int(node?.diskUsage) };
  const files = [], dirs = [];
  for (const e of entries.slice(0, 1000)) {
    const name = str(e?.name, 200);
    if (!name) continue;
    (e.type === "tree" ? dirs : files).push(name.toLowerCase());
  }
  const workflowCount = Array.isArray(workflows) ? workflows.filter((w) => /\.ya?ml$/i.test(String(w?.name || ""))).length : 0;
  return {
    observed: true,
    ownerType,
    rootEntries: files.length + dirs.length,
    manifests: files.filter((f) => MANIFESTS.has(f)).slice(0, 10),
    tests: dirs.some((d) => TEST_DIRS.has(d)) || files.some((f) => TEST_FILE.test(f)),
    sourceDirs: dirs.some((d) => SOURCE_DIRS.has(d)),
    gitignore: files.includes(".gitignore"),
    docker: files.some((f) => DOCKER_FILES.has(f)),
    ci: workflowCount > 0 || files.some((f) => CI_FILES.has(f)) || dirs.includes(".circleci"),
    workflows: workflowCount,
    releases: int(node.releases?.totalCount),
    diskKb: int(node.diskUsage),
  };
}

export function normalizeRepository(node) {
  if (!node || !Number.isSafeInteger(node.databaseId)) return null;
  const readme = [node.readmeMd, node.readmeLower, node.readmeRst, node.readmePlain].find((o) => o && Number.isFinite(o.byteSize));
  const languages = {};
  for (const edge of node.languages?.edges || [])
    if (edge?.node?.name && Number.isFinite(edge.size)) languages[String(edge.node.name).slice(0, 100)] = edge.size;
  const url = httpsUrl(node.url);
  const nameWithOwner = str(node.nameWithOwner, 300);
  if (!url || !nameWithOwner) return null;
  return {
    id: node.databaseId,
    name: str(node.name, 200) || nameWithOwner,
    nameWithOwner,
    owner: str(node.owner?.login, 100),
    url,
    description: str(node.description, 2000),
    isFork: node.isFork === true,
    isArchived: node.isArchived === true,
    pushedAt: str(node.pushedAt, 40),
    updatedAt: str(node.updatedAt, 40),
    stars: int(node.stargazerCount),
    forks: int(node.forkCount),
    primaryLanguage: str(node.primaryLanguage?.name, 100),
    languages,
    license: str(node.licenseInfo?.spdxId, 100),
    homepage: httpsUrl(node.homepageUrl),
    topics: (node.repositoryTopics?.nodes || []).map((t) => str(t?.topic?.name, 50)).filter(Boolean).slice(0, 10),
    hasReadme: !!readme,
    readmeBytes: readme ? int(readme.byteSize) : null,
    evidence: repositoryEvidence(node),
  };
}

const REPO_FIELDS = `
  databaseId name nameWithOwner url description isFork isArchived pushedAt updatedAt
  stargazerCount forkCount owner { login __typename }
  primaryLanguage { name }
  languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
  licenseInfo { spdxId }
  homepageUrl
  repositoryTopics(first: 10) { nodes { topic { name } } }
  readmeMd: object(expression: "HEAD:README.md") { ... on Blob { byteSize } }
  readmeLower: object(expression: "HEAD:readme.md") { ... on Blob { byteSize } }
  readmeRst: object(expression: "HEAD:README.rst") { ... on Blob { byteSize } }
  readmePlain: object(expression: "HEAD:README") { ... on Blob { byteSize } }
  diskUsage
  releases { totalCount }
  rootTree: object(expression: "HEAD:") { ... on Tree { entries { name type } } }
  workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
`;
export const PROFILE_QUERY = `query($login: String!) {
  viewer { login databaseId }
  user(login: $login) {
    login databaseId url
    publicRepos: repositories(privacy: PUBLIC, ownerAffiliations: [OWNER]) { totalCount }
    repositories(first: 100, privacy: PUBLIC, ownerAffiliations: [OWNER], isFork: false,
      orderBy: { field: PUSHED_AT, direction: DESC }) { totalCount nodes { ${REPO_FIELDS} } }
    organizationRepositories: repositories(first: 50, privacy: PUBLIC, ownerAffiliations: [ORGANIZATION_MEMBER], isFork: false,
      orderBy: { field: PUSHED_AT, direction: DESC }) { totalCount nodes { ${REPO_FIELDS} } }
    pinnedItems(first: 6, types: [REPOSITORY]) { nodes { ... on Repository { isPrivate ${REPO_FIELDS} } } }
    contributionsCollection {
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      totalCommitContributions
      restrictedContributionsCount
    }
  }
}`;

/** Sums the student's weekly additions (`a`) over the last 52 weeks. */
export function sumAdditions(stats, userId, login, now = Date.now()) {
  if (!Array.isArray(stats)) return 0;
  const cutoff = Math.floor((now - 52 * 7 * DAY) / 1000);
  const mine = stats.find(
    (entry) =>
      entry?.author &&
      (entry.author.id === userId || (login && String(entry.author.login || "").toLowerCase() === login.toLowerCase())),
  );
  if (!mine) return 0;
  return (mine.weeks || []).reduce((sum, week) => (week && week.w >= cutoff && Number.isSafeInteger(week.a) && week.a > 0 ? sum + week.a : sum), 0);
}

/**
 * The student's share of a repository's commits from the same contributor
 * statistics: {commits, totalCommits, contributors}. Commits are counted by
 * GitHub per author; a share says who committed, not who wrote every line.
 */
export function contributorShare(stats, userId, login) {
  if (!Array.isArray(stats)) return { commits: 0, totalCommits: 0, contributors: 0 };
  let commits = 0, totalCommits = 0, contributors = 0;
  for (const entry of stats) {
    const total = Number.isSafeInteger(entry?.total) && entry.total > 0 ? entry.total : 0;
    if (!total) continue;
    contributors++;
    totalCommits += total;
    if (entry.author && (entry.author.id === userId || (login && String(entry.author.login || "").toLowerCase() === login.toLowerCase())))
      commits += total;
  }
  return { commits, totalCommits, contributors };
}

/** Parses "2026-11-01 12:00:00 UTC" (github-authentication-token-expiration). */
export function parseTokenExpiry(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*(UTC|[+-]\d{2}:?\d{2}))?$/);
  if (!match) return null;
  const zone = !match[3] || match[3] === "UTC" ? "Z" : match[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const PAT_PATTERN = /^github_pat_[A-Za-z0-9_]{20,255}$/;
/** Throws 400-style ProviderError unless the token is a fine-grained PAT. */
export function assertFineGrainedToken(token) {
  if (typeof token !== "string" || !PAT_PATTERN.test(token))
    throw new ProviderError(
      "FINE_GRAINED_TOKEN_REQUIRED",
      "Use a fine-grained personal access token (it starts with github_pat_). Classic and OAuth tokens are not accepted.",
      { status: 400 },
    );
}

// ---- Client --------------------------------------------------------------------
/**
 * createGitHub({clientId, clientSecret, redirectUrl, fetch}) returns the provider
 * used by routes and the worker. `fetch` is injectable so tests drive the real
 * Octokit code path without network access.
 */
export function createGitHub({ clientId, clientSecret, redirectUrl, fetch, now = () => Date.now() } = {}) {
  const requestDefaults = fetch ? { fetch } : {};
  const Client = Octokit.defaults({
    log: silentLog,
    request: requestDefaults,
    // Never wait out a primary or secondary limit in-process.
    throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false },
    retry: { retries: 1, doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451] },
  });
  const client = (auth, timeout = API_TIMEOUT_MS) =>
    new Client({ ...(auth ? { auth } : {}), request: { ...requestDefaults, signal: AbortSignal.timeout(timeout) } });
  const appConfigured = !!(clientId && clientSecret && redirectUrl);
  const oauthApp = () =>
    new OAuthApp({
      clientType: "github-app",
      clientId,
      clientSecret,
      redirectUrl,
      Octokit: Client.defaults({ request: { ...requestDefaults, signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) } }),
    });
  const tokens = (data, base) => {
    const at = (seconds) => (Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? new Date(base + Number(seconds) * 1000).toISOString() : null);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: at(data.expires_in),
      refreshExpiresAt: at(data.refresh_token_expires_in),
    };
  };
  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      throw classifyGitHubError(error, now());
    }
  };

  return {
    appConfigured,
    /** Authorization URL (Octokit's web-flow URL plus the PKCE challenge). */
    authorizeUrl({ state, codeChallenge }) {
      const { url } = oauthApp().getWebFlowAuthorizationUrl({ state, redirectUrl, allowSignup: true });
      const parsed = new URL(url);
      parsed.searchParams.set("code_challenge", codeChallenge);
      parsed.searchParams.set("code_challenge_method", "S256");
      return parsed.toString();
    },
    /**
     * Code exchange with the PKCE verifier. @octokit/oauth-methods'
     * exchangeWebFlowCode has no code_verifier parameter, so the documented
     * endpoint is called through Octokit's request (no retry: codes are single-use).
     */
    async exchangeCode({ code, codeVerifier }) {
      return wrap(async () => {
        const response = await client(null, OAUTH_TIMEOUT_MS).request("POST https://github.com/login/oauth/access_token", {
          headers: { accept: "application/json" },
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUrl,
          code_verifier: codeVerifier,
          request: { retries: 0 },
        });
        const data = response.data || {};
        if (data.error || typeof data.access_token !== "string")
          throw new ProviderError("OAUTH_EXCHANGE_FAILED", "GitHub did not accept the authorization code.", { status: 400 });
        return tokens(data, now());
      });
    },
    /** Rotates both tokens (GitHub App expiring user tokens). */
    async refresh(refreshToken) {
      return wrap(async () => {
        const { authentication } = await oauthApp().refreshToken({ refreshToken });
        return {
          accessToken: authentication.token,
          refreshToken: authentication.refreshToken || null,
          expiresAt: authentication.expiresAt || null,
          refreshExpiresAt: authentication.refreshTokenExpiresAt || null,
        };
      });
    },
    /**
     * DELETE /applications/{client_id}/token: revokes exactly this one access token.
     * Never DELETE .../grant (deleteAuthorization): that would revoke every token of
     * the grant, including a newer token stored for the same student, or another
     * student's token for the same GitHub account.
     */
    async revoke(accessToken) {
      return wrap(() => oauthApp().deleteToken({ token: accessToken }));
    },
    /** GET /user for the token owner; captures a fine-grained PAT's expiry header. */
    async user(token) {
      return wrap(async () => {
        const response = await client(token, OAUTH_TIMEOUT_MS).request("GET /user");
        const data = response.data || {};
        if (!Number.isSafeInteger(data.id) || typeof data.login !== "string")
          throw new ProviderError("PROVIDER_UNAVAILABLE", "GitHub returned an unexpected profile.");
        return {
          id: data.id,
          login: data.login,
          url: `https://github.com/${data.login}`,
          tokenExpiresAt: parseTokenExpiry(response.headers?.["github-authentication-token-expiration"]),
        };
      });
    },
    /** Fine-grained PAT check (prefix first, so no network call for rejected kinds). */
    async verifyPat(token) {
      assertFineGrainedToken(token);
      return this.user(token);
    },
    /** Normalised public profile for the token owner. */
    async fetchProfile(token, { login, externalId } = {}) {
      return wrap(async () => {
        const octokit = client(token);
        let data = await octokit.graphql(PROFILE_QUERY, { login: login || "ghost" }).catch((error) => {
          // A renamed account makes user(login) NOT_FOUND; retry with the viewer's login.
          if (error?.data?.viewer?.login && error.errors?.every((e) => e?.type === "NOT_FOUND")) return { renamed: error.data.viewer.login };
          throw error;
        });
        if (data.renamed || (data.user && data.viewer && data.user.databaseId !== data.viewer.databaseId))
          data = await octokit.graphql(PROFILE_QUERY, { login: data.renamed || data.viewer.login });
        const viewer = data.viewer;
        if (!viewer || (externalId && String(viewer.databaseId) !== String(externalId)))
          throw new ProviderError("CREDENTIAL_INVALID", "The credential belongs to a different GitHub account.");
        const user = data.user;
        if (!user) throw new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "GitHub account not found.");
        const owned = (user.repositories?.nodes || []).map(normalizeRepository).filter(Boolean).filter((r) => !r.isFork);
        const pinnedNodes = (user.pinnedItems?.nodes || []).filter((n) => n && n.isPrivate !== true);
        const pinned = pinnedNodes.map(normalizeRepository).filter(Boolean);
        // Public, non-fork repositories of organisations the student belongs to, plus
        // pinned organisation repositories. Credit depends on the student's commit share.
        const mine = (repo) => repo.owner?.toLowerCase() === user.login.toLowerCase();
        const organization = [...(user.organizationRepositories?.nodes || []).map(normalizeRepository), ...pinned]
          .filter((r) => r && !r.isFork && !mine(r) && r.evidence?.ownerType === "Organization")
          .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
        const days = (user.contributionsCollection?.contributionCalendar?.weeks || [])
          .flatMap((w) => w?.contributionDays || [])
          .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
          .map((d) => ({ date: d.date, count: int(d.contributionCount) }));
        // Contributor stats for at most 10 recently pushed own repositories (lines added,
        // commit share) and 10 organisation repositories (commit share decides credit).
        const eligible = owned.filter(mine).slice(0, 10);
        const orgEligible = organization.slice(0, 10);
        const additions = {};
        const shares = {};
        let counted = 0;
        let pending = 0;
        let orgPending = 0;
        for (const repo of [...eligible, ...orgEligible]) {
          const own = mine(repo);
          const [owner, name] = repo.nameWithOwner.split("/");
          let response;
          try {
            response = await octokit.request("GET /repos/{owner}/{repo}/stats/contributors", { owner, repo: name });
          } catch (error) {
            const classified = classifyGitHubError(error, now());
            if (classified.code === "CREDENTIAL_INVALID") throw classified;
            if (classified.code === "RATE_LIMITED") break; // keep what we have; coverage is partial
            continue;
          }
          if (response.status === 202) {
            if (own) pending++;
            else orgPending++;
            continue;
          }
          additions[repo.id] = response.status === 204 ? 0 : sumAdditions(response.data, user.databaseId, user.login, now());
          if (response.status !== 204) shares[repo.id] = contributorShare(response.data, user.databaseId, user.login);
          if (own) counted++;
        }
        // The lines-added metric stays about the student's own repositories.
        const lines = eligible.reduce((sum, r) => sum + (additions[r.id] ?? 0), 0);
        return {
          account: { login: user.login, id: user.databaseId, url: `https://github.com/${user.login}` },
          publicRepos: int(user.publicRepos?.totalCount),
          originalRepos: int(user.repositories?.totalCount),
          repositories: owned,
          pinned,
          organizationRepositories: organization,
          organizationStatsPending: orgPending,
          calendar: {
            total: int(user.contributionsCollection?.contributionCalendar?.totalContributions),
            commits: int(user.contributionsCollection?.totalCommitContributions),
            restricted: int(user.contributionsCollection?.restrictedContributionsCount),
            days,
          },
          linesAdded: { value: counted ? lines : null, counted, eligible: eligible.length, pending },
          additions,
          shares,
        };
      });
    },
  };
}
