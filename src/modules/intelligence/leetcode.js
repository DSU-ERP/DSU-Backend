// LeetCode public profile data for linked usernames. LeetCode publishes no
// documented API; this reads the public GraphQL fields its profile page uses
// (solved counts, topic tags, contest summary, profile name).
//
// Efficiency and politeness:
// - Batching: fetchProfile() calls arriving within a short window are merged
//   into one request with GraphQL aliases (up to `batchSize` usernames).
// - Spacing: requests are at least `minIntervalMs` apart.
// - Shared back-off: a 429 or 403 pauses every LeetCode call until the reset;
//   calls during the pause fail fast with RATE_LIMITED (no request), and the
//   sync queue reschedules them without using up attempts.
// Fixed host, POST only, no redirects, 1 MiB response cap, defensive parsing.
// Only the background sync worker calls this, never page rendering.
import { ProviderError } from "./platforms.js";
import { rateLimitDelay, readCapped } from "./huggingface.js";

const ENDPOINT = "https://leetcode.com/graphql";
const TIMEOUT_MS = 15000;
const BLOCK_MS = 15 * 60 * 1000;
const USERNAME = /^[A-Za-z0-9_-]{1,30}$/;

const USER_FIELDS = `username
    profile { realName }
    submitStatsGlobal { acSubmissionNum { difficulty count } }
    tagProblemCounts {
      advanced { tagName tagSlug problemsSolved }
      intermediate { tagName tagSlug problemsSolved }
      fundamental { tagName tagSlug problemsSolved }
    }`;

/** One query for n usernames: aliases m<i> (profile) and c<i> (contest) per variable u<i>. */
export function batchQuery(n) {
  const vars = Array.from({ length: n }, (_, i) => `$u${i}: String!`).join(", ");
  const fields = Array.from(
    { length: n },
    (_, i) => `  m${i}: matchedUser(username: $u${i}) {\n    ${USER_FIELDS}\n  }\n  c${i}: userContestRanking(username: $u${i}) { attendedContestsCount rating }`,
  ).join("\n");
  return `query(${vars}) {\n${fields}\n}`;
}
export const LEETCODE_QUERY = batchQuery(1);

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const SLUG = /^[a-z0-9-]{1,60}$/;

/** Normalises one user's {matchedUser, userContestRanking}; null when the user does not exist. */
export function normalizeLeetCode(data) {
  const user = data?.matchedUser;
  if (!user || typeof user !== "object") return null;
  const solved = { all: null, easy: null, medium: null, hard: null };
  for (const row of user.submitStatsGlobal?.acSubmissionNum || []) {
    const key = String(row?.difficulty || "").toLowerCase();
    if (key in solved) solved[key] = count(row.count);
  }
  const tags = [];
  for (const level of ["fundamental", "intermediate", "advanced"])
    for (const t of user.tagProblemCounts?.[level] || []) {
      const solvedCount = count(t?.problemsSolved);
      if (typeof t?.tagSlug === "string" && SLUG.test(t.tagSlug) && solvedCount !== null)
        tags.push({ slug: t.tagSlug, name: String(t.tagName || t.tagSlug).slice(0, 60), solved: solvedCount, level });
    }
  const contest = data.userContestRanking;
  const rating = typeof contest?.rating === "number" && Number.isFinite(contest.rating) && contest.rating >= 0 ? Math.round(contest.rating) : null;
  const realName = typeof user.profile?.realName === "string" && user.profile.realName.trim() ? user.profile.realName.trim().slice(0, 100) : null;
  return {
    account: { username: typeof user.username === "string" ? user.username.slice(0, 100) : null },
    realName,
    solved,
    contest: rating === null ? null : { rating, attended: count(contest.attendedContestsCount) ?? 0 },
    tags: tags.sort((a, b) => b.solved - a.solved || a.slug.localeCompare(b.slug)).slice(0, 100),
  };
}

export function createLeetCode({
  fetch = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  batchSize = 10,
  windowMs = 50,
  minIntervalMs = 1500,
} = {}) {
  let queue = [];
  let timer = null;
  let nextSlot = 0;
  let blockedUntil = 0;
  let chain = Promise.resolve();

  const limited = () => new ProviderError("RATE_LIMITED", "LeetCode rate limit reached.", { status: 429, retryAt: new Date(blockedUntil) });

  /** One HTTP request for a group of usernames. Resolves to {username(lowercase): profile|null}. */
  async function request(usernames) {
    const wait = Math.max(0, nextSlot - now());
    if (wait) await sleep(wait);
    if (now() < blockedUntil) throw limited();
    nextSlot = now() + minIntervalMs;
    const variables = Object.fromEntries(usernames.map((u, i) => [`u${i}`, u]));
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", referer: "https://leetcode.com/" },
        body: JSON.stringify({ query: batchQuery(usernames.length), variables }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError("PROVIDER_UNAVAILABLE", "LeetCode is unavailable.");
    }
    if (response.status === 429 || response.status === 403) {
      // 403 here is LeetCode's bot protection: treat it as a rate limit, not a dead account.
      const delay = response.status === 429 ? (rateLimitDelay(response.headers) ?? 300) * 1000 : BLOCK_MS;
      blockedUntil = now() + delay + 1000;
      await response.body?.cancel?.().catch(() => {});
      throw limited();
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new ProviderError("PROVIDER_UNAVAILABLE", "LeetCode is unavailable.", { status: response.status });
    }
    let body;
    try {
      body = JSON.parse(await readCapped(response));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("PROVIDER_UNAVAILABLE", "LeetCode returned an unreadable response.");
    }
    const data = body?.data;
    if (!data || typeof data !== "object") throw new ProviderError("PROVIDER_UNAVAILABLE", "LeetCode returned an unexpected profile.");
    return Object.fromEntries(
      usernames.map((u, i) => [u.toLowerCase(), normalizeLeetCode({ matchedUser: data[`m${i}`], userContestRanking: data[`c${i}`] })]),
    );
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    const group = queue.splice(0, batchSize);
    if (queue.length) timer = setTimeout(flush, windowMs);
    if (!group.length) return;
    const usernames = group.map((entry) => entry.username);
    // Requests run one after another so spacing and back-off apply to all of them.
    chain = chain.then(async () => {
      try {
        const profiles = await request(usernames);
        for (const entry of group) {
          const profile = profiles[entry.username.toLowerCase()];
          for (const w of entry.waiters)
            if (!profile) w.reject(new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "LeetCode account not found.", { status: 404 }));
            else if (profile.solved.all === null) w.reject(new ProviderError("PROVIDER_UNAVAILABLE", "LeetCode returned no solved-problem counts."));
            else w.resolve(profile);
        }
      } catch (error) {
        for (const entry of group) for (const w of entry.waiters) w.reject(error);
      }
    });
  }

  return {
    batchSize,
    /** Normalised public profile for one username; batched with concurrent calls. */
    fetchProfile(username) {
      if (typeof username !== "string" || !USERNAME.test(username))
        return Promise.reject(new ProviderError("PLATFORM_ACCOUNT_NOT_FOUND", "LeetCode account not found."));
      if (now() < blockedUntil) return Promise.reject(limited());
      return new Promise((resolve, reject) => {
        // The same username (any case) waiting already shares its slot and answer.
        const same = queue.find((entry) => entry.username.toLowerCase() === username.toLowerCase());
        if (same) return void same.waiters.push({ resolve, reject });
        queue.push({ username, waiters: [{ resolve, reject }] });
        if (queue.length >= batchSize) flush();
        else if (!timer) timer = setTimeout(flush, windowMs);
      });
    },
  };
}
