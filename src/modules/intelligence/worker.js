// In-process sync worker. Polls every 5 s, runs at most `concurrency` jobs at
// once, enqueues scheduled refreshes every 10 minutes and backs off quietly
// (one log line) while the database has not been migrated yet.
import { isPendingMigration } from "../../platform/http/errors.js";
import { createSecrets } from "../../platform/crypto/secrets.js";
import { claimJobs, enqueueScheduled, runJob } from "./sync.js";
import { createGitHub } from "./github.js";
import { createHuggingFace } from "./huggingface.js";

const POLL_MS = 5000;
const SCHEDULE_MS = 10 * 60 * 1000;
const MIGRATION_RETRY_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 20000;

const jsonLog = (entry) => console.log(JSON.stringify(entry));

/** Provider clients from env, with test/host overrides from `integrations`. */
export function createProviders(env = {}, integrations = {}) {
  return {
    secrets: integrations?.secrets ?? createSecrets(env),
    github:
      integrations?.github ??
      createGitHub({
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        redirectUrl: env.GITHUB_OAUTH_REDIRECT_URL,
      }),
    huggingface: integrations?.huggingface ?? createHuggingFace(),
  };
}

export function createSyncWorker({
  pool,
  env = {},
  integrations,
  log = jsonLog,
  now = Date.now,
  pollMs = POLL_MS,
  scheduleMs = SCHEDULE_MS,
  migrationRetryMs = MIGRATION_RETRY_MS,
} = {}) {
  const concurrency = Math.min(4, Math.max(1, Number(env.SYNC_WORKER_CONCURRENCY) || 2));
  const intervalHours = Math.min(168, Math.max(1, Number(env.SYNC_INTERVAL_HOURS) || 24));
  const ctx = { pool, ...createProviders(env, integrations), now, log };
  const inFlight = new Set();
  let timer = null;
  let running = false;
  let ticking = false;
  let lastSchedule = 0;
  let waitingUntil = 0;
  let waitingLogged = false;

  const waitForMigration = (error) => {
    if (!isPendingMigration(error)) return false;
    waitingUntil = now() + migrationRetryMs;
    if (!waitingLogged) log({ event: "sync_worker_waiting_for_migration", code: error.code });
    waitingLogged = true;
    return true;
  };

  async function tick() {
    if (ticking || now() < waitingUntil) return 0;
    ticking = true;
    try {
      if (now() - lastSchedule >= scheduleMs) {
        lastSchedule = now();
        const queued = await enqueueScheduled(pool, intervalHours);
        if (queued) log({ event: "sync_scheduled", count: queued });
      }
      const jobs = await claimJobs(pool, concurrency - inFlight.size);
      if (waitingLogged) {
        waitingLogged = false;
        log({ event: "sync_worker_ready" });
      }
      for (const job of jobs) {
        const task = runJob(ctx, job)
          .catch((error) => {
            if (!waitForMigration(error)) log({ event: "sync_job_error", jobId: String(job.id), code: error?.code || "SYNC_FAILED" });
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      return jobs.length;
    } catch (error) {
      if (!waitForMigration(error)) log({ event: "sync_worker_error", code: error?.code || "SYNC_WORKER_ERROR" });
      return 0;
    } finally {
      ticking = false;
    }
  }

  const loop = async () => {
    await tick();
    if (running) {
      timer = setTimeout(loop, pollMs);
      timer.unref?.();
    }
  };

  return {
    concurrency,
    tick,
    /** Runs one claim cycle and waits for the claimed jobs (tests, scripts). */
    async runOnce() {
      const count = await tick();
      await Promise.allSettled([...inFlight]);
      return count;
    },
    start() {
      if (running) return;
      running = true;
      timer = setTimeout(loop, 0);
      timer.unref?.();
    },
    /** Stops polling and waits (bounded) for in-flight jobs to finish. */
    async stop(timeoutMs = STOP_TIMEOUT_MS) {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      let bound;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => {
          bound = setTimeout(resolve, timeoutMs);
          bound.unref?.();
        }),
      ]);
      clearTimeout(bound);
    },
  };
}
