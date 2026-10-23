// Platform sync: job queue (student.sync_jobs), credential access and the
// result writer. Provider calls always happen outside database transactions;
// the only exception is a GitHub token refresh, which runs under a row lock on
// the credential so exactly one refresh (and rotation) happens at a time.
// Never log or store tokens, ciphers or provider payloads in logs.
import { isPendingMigration } from "../../platform/http/errors.js";
import { ProviderError, SYNCABLE_AUTH } from "./platforms.js";
import {
  LANGUAGE_NOTE,
  LINES_NOTE,
  RANKING_NOTE,
  STREAK_NOTE,
  contributionStreaks,
  languageShare,
  scoreRepository,
} from "./github.js";

export const LEASE = "2 minutes";
export const SNAPSHOTS_KEPT = 5;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Human labels live in constants.js so every view shares them.
export { METRIC_LABELS } from "./constants.js";

/** Additional authenticated data binding a cipher to its row and purpose. */
export const credentialAad = (accountId, kind, field) => `platform_credentials:${accountId}:${kind}:${field}`;
export const oauthStateAad = (stateHash) => `oauth_states:${stateHash}`;

/** Worker transaction: app.sync_worker='on' (and optionally credential access), no actor. */
export async function workerTransaction(pool, fn, { credentials = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      credentials
        ? "SELECT set_config('app.sync_worker','on',true), set_config('app.credential_access','on',true)"
        : "SELECT set_config('app.sync_worker','on',true)",
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Idempotent enqueue (respects sync_jobs_one_open). Works for a student actor
 * (job_owner_insert) and for the worker. Returns the new job id or null when an
 * open job already exists.
 */
export async function enqueue(client, account, reason, { delaySeconds = 0 } = {}) {
  const { rows } = await client.query(
    `INSERT INTO student.sync_jobs(account_id,student_id,platform,reason,run_after)
     VALUES($1,$2,$3,$4,now()+make_interval(secs=>$5))
     ON CONFLICT (account_id) WHERE status IN ('pending','running') DO NOTHING RETURNING id`,
    [account.id, account.student_id, account.platform, reason, delaySeconds],
  );
  return rows[0]?.id ?? null;
}

/** Fails jobs whose lease expired after their last attempt; returns their accounts. */
async function expireLeases(client) {
  const { rows } = await client.query(
    `UPDATE student.sync_jobs SET status='failed',last_error='LEASE_EXPIRED',leased_until=NULL,updated_at=now()
     WHERE status='running' AND leased_until<now() AND attempts>=max_attempts RETURNING account_id`,
  );
  if (rows.length)
    await client.query(
      "UPDATE student.platform_accounts SET sync_status='failed',sync_error='LEASE_EXPIRED',updated_at=now() WHERE id=ANY($1::uuid[]) AND sync_status IN ('pending','running')",
      [rows.map((r) => r.account_id)],
    );
}

/** Claims up to `limit` due jobs (and expired leases) with SKIP LOCKED. */
export async function claimJobs(pool, limit) {
  if (limit < 1) return [];
  return workerTransaction(pool, async (client) => {
    await expireLeases(client);
    const { rows } = await client.query(
      `WITH due AS (
         SELECT id FROM student.sync_jobs
         WHERE (status='pending' AND run_after<=now()) OR (status='running' AND leased_until<now())
         ORDER BY run_after, id LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE student.sync_jobs j SET status='running',leased_until=now()+interval '${LEASE}',
         attempts=j.attempts+1,updated_at=now()
       FROM due WHERE j.id=due.id
       RETURNING j.id,j.account_id,j.student_id,j.platform,j.reason,j.attempts,j.max_attempts`,
      [limit],
    );
    return rows;
  });
}

/** Enqueues 'scheduled' jobs for linked syncable accounts older than intervalHours. */
export async function enqueueScheduled(pool, intervalHours) {
  return workerTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO student.sync_jobs(account_id,student_id,platform,reason)
       SELECT a.id,a.student_id,a.platform,'scheduled' FROM student.platform_accounts a
       WHERE a.state='linked' AND a.auth_method=ANY($2::text[])
         AND coalesce(a.sync_error,'')<>'CREDENTIAL_INVALID'
         AND (a.last_synced_at IS NULL OR a.last_synced_at<now()-make_interval(hours=>$1))
         AND NOT EXISTS(SELECT 1 FROM student.sync_jobs j WHERE j.account_id=a.id
           AND (j.status IN ('pending','running') OR (j.status='failed' AND j.updated_at>now()-make_interval(hours=>$1))))
       ORDER BY a.last_synced_at NULLS FIRST LIMIT 200
       ON CONFLICT (account_id) WHERE status IN ('pending','running') DO NOTHING RETURNING id`,
      [intervalHours, SYNCABLE_AUTH],
    );
    return rows.length;
  });
}

// ---- Credentials -------------------------------------------------------------
const expired = (value, margin = 0, now = Date.now()) => value && new Date(value).getTime() <= now + margin;

/**
 * Returns a usable GitHub access token for the account, refreshing (and
 * rotating both tokens) under a row lock when it is expired or close to it.
 */
export async function githubAccessToken({ pool, secrets, github, now = Date.now }, account) {
  const select = `SELECT kind,access_cipher,refresh_cipher,access_expires_at,refresh_expires_at
    FROM student.platform_credentials WHERE account_id=$1`;
  const current = (await workerTransaction(pool, (c) => c.query(select, [account.id]), { credentials: true })).rows[0];
  if (!current) throw new ProviderError("CREDENTIAL_INVALID", "No stored credential.");
  const decrypt = (row, field) => secrets.decrypt(row[field + "_cipher"], credentialAad(account.id, row.kind, field));
  if (current.kind === "github_pat") {
    if (expired(current.access_expires_at, 0, now())) throw new ProviderError("CREDENTIAL_INVALID", "The access token has expired.");
    return decrypt(current, "access");
  }
  if (!expired(current.access_expires_at, REFRESH_MARGIN_MS, now())) return decrypt(current, "access");
  if (!current.refresh_cipher || expired(current.refresh_expires_at, 0, now()))
    throw new ProviderError("CREDENTIAL_INVALID", "The authorization has expired.");
  if (!github?.refresh) throw new ProviderError("PROVIDER_UNAVAILABLE", "GitHub App is not configured.");
  return workerTransaction(
    pool,
    async (client) => {
      const locked = (await client.query(select + " FOR UPDATE", [account.id])).rows[0];
      if (!locked) throw new ProviderError("CREDENTIAL_INVALID", "No stored credential.");
      // Another worker may have refreshed while we waited for the lock.
      if (!expired(locked.access_expires_at, REFRESH_MARGIN_MS, now())) return decrypt(locked, "access");
      const next = await github.refresh(decrypt(locked, "refresh"));
      await client.query(
        `UPDATE student.platform_credentials SET key_id=$2,access_cipher=$3,refresh_cipher=$4,
           access_expires_at=$5,refresh_expires_at=$6,updated_at=now() WHERE account_id=$1`,
        [
          account.id,
          secrets.keyId,
          secrets.encrypt(next.accessToken, credentialAad(account.id, locked.kind, "access")),
          next.refreshToken ? secrets.encrypt(next.refreshToken, credentialAad(account.id, locked.kind, "refresh")) : null,
          next.expiresAt,
          next.refreshExpiresAt,
        ],
      );
      return next.accessToken;
    },
    { credentials: true },
  );
}

// ---- Result builders (pure) -------------------------------------------------
const metric = (key, value, { verification = "platform_verified", method, note = null }) => ({ key, value, verification, method, note });

export function githubResult(payload, now = Date.now()) {
  const method = "github_graphql";
  const streaks = contributionStreaks(payload.calendar.days.map((d) => ({ date: d.date, contributionCount: d.count })), now);
  const lines = payload.linesAdded;
  const metrics = [
    metric("repos.public", payload.publicRepos, { method }),
    metric("repos.original", payload.originalRepos, { method }),
    metric("languages.top", languageShare(payload.repositories), { method, note: LANGUAGE_NOTE }),
    metric("contributions.total_12m", payload.calendar.total, { method }),
    metric("contributions.commits_12m", payload.calendar.commits, { method }),
    metric("contributions.private_12m", payload.calendar.restricted, {
      method,
      note: "Contributions to private repositories are counted by GitHub but never described.",
    }),
    metric("contributions.lines_added_52w", lines, {
      method: "github_rest_stats",
      verification: lines.counted ? "platform_verified" : "unavailable",
      note: LINES_NOTE + (lines.counted < lines.eligible ? ` Counted ${lines.counted} of ${lines.eligible} repositories.` : ""),
    }),
    metric("activity.current_streak", streaks.current, { method, note: STREAK_NOTE }),
    metric("activity.longest_streak", streaks.longest, { method, note: STREAK_NOTE }),
    metric("activity.active_days", streaks.activeDays, { method, note: STREAK_NOTE }),
    metric("activity.calendar", { days: payload.calendar.days.filter((d) => d.count > 0) }, { method, note: STREAK_NOTE }),
  ];
  const pinOrder = new Map(payload.pinned.map((r, i) => [r.id, i + 1]));
  const byId = new Map();
  for (const repo of [...payload.repositories, ...payload.pinned]) if (!byId.has(repo.id)) byId.set(repo.id, repo);
  const repositories = [...byId.values()].map((repo) => {
    const { score, reasons } = scoreRepository(repo, now);
    return {
      repo_id: repo.id,
      full_name: repo.nameWithOwner,
      name: repo.name,
      url: repo.url,
      description: repo.description,
      primary_language: repo.primaryLanguage,
      languages: repo.languages,
      topics: repo.topics,
      stars: repo.stars,
      forks: repo.forks,
      is_fork: repo.isFork,
      is_archived: repo.isArchived,
      has_readme: repo.hasReadme,
      readme_bytes: repo.readmeBytes,
      license: repo.license,
      homepage: repo.homepage,
      pushed_at: repo.pushedAt,
      repo_updated_at: repo.updatedAt,
      owner_login: repo.owner,
      pinned: pinOrder.has(repo.id),
      pin_order: pinOrder.get(repo.id) ?? null,
      recommendation_score: score,
      recommendation_reasons: reasons,
      additions_52w: payload.additions?.[repo.id] ?? null,
    };
  });
  const status = lines.pending > 0 || lines.counted < lines.eligible ? "partial" : "completed";
  return {
    status,
    method,
    handle: payload.account.login,
    profileUrl: payload.account.url,
    externalId: String(payload.account.id),
    retryStats: lines.pending > 0,
    metrics,
    repositories,
    snapshot: {
      account: payload.account,
      publicRepos: payload.publicRepos,
      originalRepos: payload.originalRepos,
      repositoryIds: repositories.map((r) => r.repo_id),
      pinnedIds: payload.pinned.map((r) => r.id),
      contributions: { total: payload.calendar.total, commits: payload.calendar.commits },
      streaks,
      linesAdded: lines,
      rankingNote: RANKING_NOTE,
    },
  };
}

export function huggingFaceResult(payload) {
  const method = "huggingface_hub_api";
  const note = "From the public Hugging Face Hub API for the linked username. Account ownership is student-submitted.";
  const metrics = [];
  for (const kind of ["models", "datasets", "spaces"]) {
    const value = payload.counts[kind];
    metrics.push(metric(`${kind}.count`, value, { method, note, verification: value === null ? "unavailable" : "platform_verified" }));
    metrics.push(metric(`${kind}.top`, payload.top[kind], { method, note }));
  }
  const complete = Object.values(payload.counts).every((v) => v !== null);
  return { status: complete ? "completed" : "partial", method, metrics, repositories: null, snapshot: payload };
}

// ---- Writing results -----------------------------------------------------------
const REPO_COLUMNS = `repo_id bigint,full_name text,name text,url text,description text,primary_language text,languages jsonb,
  topics jsonb,stars integer,forks integer,is_fork boolean,is_archived boolean,has_readme boolean,readme_bytes integer,license text,
  homepage text,pushed_at timestamptz,repo_updated_at timestamptz,owner_login text,pinned boolean,pin_order integer,
  recommendation_score integer,recommendation_reasons jsonb,additions_52w integer`;
const REPO_NAMES = REPO_COLUMNS.split(",").map((c) => c.trim().split(" ")[0]);
const REPO_SET = REPO_NAMES.filter((c) => c !== "repo_id")
  .map((c) => `${c}=EXCLUDED.${c}`)
  .join(",");

export async function writeResult(client, job, account, result) {
  const snapshot = (
    await client.query(
      `INSERT INTO student.platform_snapshots(account_id,student_id,platform,status,method,payload)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [account.id, account.student_id, account.platform, result.status, result.method, JSON.stringify(result.snapshot)],
    )
  ).rows[0].id;
  await client.query(
    `INSERT INTO student.platform_metrics(account_id,metric,student_id,platform,value,verification,method,snapshot_id,collected_at,note)
     SELECT $1,m.key,$2,$3,m.value,m.verification,m.method,$4,now(),m.note
     FROM jsonb_to_recordset($5::jsonb) AS m(key text,value jsonb,verification text,method text,note text)
     ON CONFLICT (account_id,metric) DO UPDATE SET value=EXCLUDED.value,verification=EXCLUDED.verification,
       method=EXCLUDED.method,snapshot_id=EXCLUDED.snapshot_id,collected_at=EXCLUDED.collected_at,note=EXCLUDED.note`,
    [account.id, account.student_id, account.platform, snapshot, JSON.stringify(result.metrics)],
  );
  await client.query("DELETE FROM student.platform_metrics WHERE account_id=$1 AND metric<>ALL($2::text[])", [
    account.id,
    result.metrics.map((m) => m.key),
  ]);
  if (result.repositories) {
    await client.query(
      `INSERT INTO student.github_repositories(account_id,student_id,snapshot_id,updated_at,${REPO_NAMES.join(",")})
       SELECT $1,$2,$3,now(),r.* FROM jsonb_to_recordset($4::jsonb) AS r(${REPO_COLUMNS})
       ON CONFLICT (account_id,repo_id) DO UPDATE SET ${REPO_SET},snapshot_id=EXCLUDED.snapshot_id,updated_at=now()`,
      [account.id, account.student_id, snapshot, JSON.stringify(result.repositories)],
    );
    await client.query("DELETE FROM student.github_repositories WHERE account_id=$1 AND repo_id<>ALL($2::bigint[])", [
      account.id,
      result.repositories.map((r) => String(r.repo_id)),
    ]);
  }
  await client.query(
    `DELETE FROM student.platform_snapshots WHERE account_id=$1 AND id NOT IN
       (SELECT id FROM student.platform_snapshots WHERE account_id=$1 ORDER BY collected_at DESC,id LIMIT ${SNAPSHOTS_KEPT})`,
    [account.id],
  );
  await client.query(
    `UPDATE student.platform_accounts SET sync_status=$2,sync_error=NULL,last_synced_at=now(),last_attempt_at=now(),
       handle=coalesce($3,handle),profile_url=coalesce($4,profile_url),updated_at=now() WHERE id=$1`,
    [account.id, result.status, result.handle ?? null, result.profileUrl ?? null],
  );
  await client.query(
    "UPDATE student.sync_jobs SET status=$2,leased_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1",
    [job.id, result.status],
  );
  // GitHub computes contributor statistics lazily (202): look again shortly, once.
  if (result.retryStats && job.reason !== "retry") await enqueue(client, account, "retry", { delaySeconds: 300 });
  return snapshot;
}

const TERMINAL = new Set(["CREDENTIAL_INVALID", "PLATFORM_ACCOUNT_NOT_FOUND"]);

/**
 * Locks the job row (after the account row, the same order as the student
 * routes) and reports whether this worker still owns it: status 'running' and
 * the same attempt number it claimed. A cancelled job (disconnect or relink)
 * or a lease another worker reclaimed must never write results or errors.
 */
async function ownsJob(client, job) {
  const row = (await client.query("SELECT status,attempts FROM student.sync_jobs WHERE id=$1 FOR UPDATE", [job.id])).rows[0];
  return !!row && row.status === "running" && row.attempts === job.attempts;
}

/** True when the account is still the identity the job ran with (no relink since). */
const sameIdentity = (latest, ran) =>
  !!latest &&
  latest.state === "linked" &&
  (!ran || (latest.external_id === ran.external_id && (latest.platform === "github" || latest.handle === ran.handle)));

/**
 * Records a failed attempt. `ran` is {external_id, handle} of the account the job
 * ran against (null when the failure happened before the account was read).
 * Returns {code, stale}; a stale job changes nothing.
 */
export async function recordFailure(pool, job, error, now = Date.now(), ran = null) {
  const code = error instanceof ProviderError ? error.code : "SYNC_FAILED";
  const stale = await workerTransaction(pool, async (client) => {
    const latest = (await client.query("SELECT * FROM student.platform_accounts WHERE id=$1 FOR UPDATE", [job.account_id])).rows[0];
    if (!(await ownsJob(client, job))) return true;
    if (latest && !sameIdentity(latest, ran)) {
      // The student disconnected or relinked while the provider call ran: the
      // failure belongs to the old identity, so leave the account alone.
      await client.query("UPDATE student.sync_jobs SET status='cancelled',leased_until=NULL,updated_at=now() WHERE id=$1", [job.id]);
      return true;
    }
    const account = latest;
    const setAccount = (status, syncError) =>
      account &&
      client.query(
        "UPDATE student.platform_accounts SET sync_status=$2,sync_error=$3,last_attempt_at=now(),updated_at=now() WHERE id=$1 AND state='linked'",
        [job.account_id, status, syncError],
      );
    const setJob = (status, runAt, extra = "") =>
      client.query(
        `UPDATE student.sync_jobs SET status=$2,last_error=$3,leased_until=NULL,run_after=coalesce($4::timestamptz,run_after),
           updated_at=now()${extra} WHERE id=$1`,
        [job.id, status, code, runAt],
      );
    if (TERMINAL.has(code)) {
      await setJob("failed", null);
      await setAccount("failed", code);
    } else if (code === "RATE_LIMITED") {
      // Rate limits do not consume attempts; resume after the provider's reset.
      const runAt = new Date(Math.max(error.retryAt?.getTime?.() || 0, now + 60000)).toISOString();
      await setJob("pending", runAt, ",attempts=greatest(attempts-1,0),reason='retry'");
      await setAccount("pending", code);
    } else if (job.attempts >= job.max_attempts) {
      await setJob("failed", null);
      await setAccount("failed", code);
    } else {
      const runAt = new Date(now + 2 ** job.attempts * 60000).toISOString();
      await setJob("pending", runAt, ",reason='retry'");
      await setAccount("failed", code);
    }
    return false;
  });
  return { code, stale };
}

/**
 * Runs one claimed job end to end. ctx: {pool, secrets, github, huggingface, now, log}.
 * Returns the final job status.
 */
export async function runJob(ctx, job) {
  const now = ctx.now || Date.now;
  // Identity the job runs against; failures are recorded only while it still matches.
  let ran = null;
  try {
    const account = (
      await workerTransaction(ctx.pool, (c) =>
        c.query(
          "UPDATE student.platform_accounts SET sync_status='running',last_attempt_at=now() WHERE id=$1 AND state='linked' RETURNING *",
          [job.account_id],
        ),
      )
    ).rows[0];
    if (!account || !SYNCABLE_AUTH.includes(account.auth_method)) {
      await workerTransaction(ctx.pool, (c) =>
        c.query("UPDATE student.sync_jobs SET status='cancelled',leased_until=NULL,updated_at=now() WHERE id=$1", [job.id]),
      );
      if (account)
        await workerTransaction(ctx.pool, (c) =>
          c.query("UPDATE student.platform_accounts SET sync_status='not_applicable' WHERE id=$1", [account.id]),
        );
      return "cancelled";
    }
    ran = { external_id: account.external_id, handle: account.handle };
    let result;
    if (account.platform === "github") {
      if (!ctx.github) throw new ProviderError("PROVIDER_UNAVAILABLE", "GitHub is not configured.");
      const token = await githubAccessToken({ ...ctx, now }, account);
      const payload = await ctx.github.fetchProfile(token, { login: account.handle, externalId: account.external_id });
      result = githubResult(payload, now());
    } else if (account.platform === "huggingface") {
      if (!ctx.huggingface) throw new ProviderError("PROVIDER_UNAVAILABLE", "Hugging Face is not configured.");
      result = huggingFaceResult(await ctx.huggingface.fetchProfile(account.handle));
    } else throw new ProviderError("PROVIDER_UNAVAILABLE", "Platform is not syncable.");
    const written = await workerTransaction(ctx.pool, async (client) => {
      // The student may have disconnected or relinked while the provider call ran.
      const latest = (
        await client.query("SELECT * FROM student.platform_accounts WHERE id=$1 FOR UPDATE", [account.id])
      ).rows[0];
      // A cancelled job or a lost lease (another worker reclaimed it) writes nothing.
      if (!(await ownsJob(client, job))) return false;
      if (!sameIdentity(latest, ran)) {
        await client.query("UPDATE student.sync_jobs SET status='cancelled',leased_until=NULL,updated_at=now() WHERE id=$1", [job.id]);
        return false;
      }
      await writeResult(client, job, latest, result);
      return true;
    });
    ctx.log?.({ event: "sync_job_finished", jobId: String(job.id), platform: job.platform, status: written ? result.status : "cancelled" });
    return written ? result.status : "cancelled";
  } catch (error) {
    if (isPendingMigration(error)) throw error;
    const { code, stale } = await recordFailure(ctx.pool, job, error, now(), ran);
    if (stale) {
      ctx.log?.({ event: "sync_job_stale", jobId: String(job.id), platform: job.platform, code });
      return "cancelled";
    }
    ctx.log?.({ event: "sync_job_failed", jobId: String(job.id), platform: job.platform, code });
    return "failed";
  }
}
