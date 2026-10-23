// Student skills routes (docs/STUDENT-INTELLIGENCE.md section 4): onboarding,
// platform connections (GitHub App web flow with PKCE, fine-grained PAT,
// Hugging Face public API, link-only platforms), manual refresh and featured
// projects. GET /student/skills/profile and POST /student/skills/summary live in
// profile-routes.js. Responses never include tokens, ciphers or OAuth state.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { httpError } from "../../platform/http/errors.js";
import { runStudent } from "../students/context.js";
import { ONBOARDING_VERSION, PLATFORMS, REQUIRED_PLATFORMS, onboardingStatus } from "./constants.js";
import {
  ProviderError,
  SYNCABLE_AUTH,
  normalizePlatformValue,
  validateSubmitted,
} from "./platforms.js";
import { METRIC_LABELS, credentialAad, enqueue, oauthStateAad } from "./sync.js";
import { createProviders } from "./worker.js";

const OAUTH_STATE_MINUTES = 10;
const REFRESH_LIMIT_MINUTES = 10;
const CONSENT_VERSION = 1;

// ---- Shared helpers (also used by /session and the dashboard gate) -----------
/** True when a linked student still has to complete the current skills onboarding. */
export async function onboardingRequired(client, studentId) {
  const ready = (await client.query("SELECT to_regclass('student.skill_profiles') IS NOT NULL AS ready")).rows[0]?.ready;
  // Before the intelligence migration is applied there is nothing to complete.
  if (!ready) return false;
  const { rows } = await client.query("SELECT onboarding_version,identity_confirmed_at,visibility_saved_at FROM student.skill_profiles WHERE student_id=$1", [studentId]);
  const profile = rows[0];
  if ((profile?.onboarding_version ?? 0) < ONBOARDING_VERSION) return true;
  const accounts = (await client.query("SELECT platform,state FROM student.platform_accounts WHERE student_id=$1", [studentId])).rows;
  return onboardingStatus(profile, accounts).missing.length > 0;
}

export function accountView(row, metrics = []) {
  return {
    platform: row.platform,
    state: row.state,
    handle: row.handle ?? null,
    profileUrl: row.profile_url ?? null,
    authMethod: row.auth_method,
    ownership: row.ownership,
    visible: row.visible,
    syncStatus: row.sync_status,
    syncError: row.sync_error ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
    submitted: row.submitted ?? {},
    metrics: metrics.map((m) => ({
      metric: m.metric,
      label: METRIC_LABELS[m.metric] ?? m.metric,
      value: m.value,
      verification: m.verification,
      method: m.method,
      collectedAt: m.collected_at,
      note: m.note ?? null,
    })),
  };
}

/** An error answered directly so extra fields (missing, fields) and 503 codes survive. */
const direct = (statusCode, code, message, extra = {}) => Object.assign(new Error(message), { statusCode, code, direct: true, extra });
const DIRECT_CODES = new Set(["INTEGRATIONS_NOT_CONFIGURED"]);
const providerFailure = (error) => {
  switch (error.code) {
    case "FINE_GRAINED_TOKEN_REQUIRED":
      return direct(400, error.code, error.message);
    case "CREDENTIAL_INVALID":
      return direct(400, "GITHUB_TOKEN_INVALID", "GitHub did not accept this token. Check it and try again.");
    case "OAUTH_EXCHANGE_FAILED":
      return direct(400, error.code, "GitHub did not accept the authorization. Please connect again.");
    case "RATE_LIMITED":
      return direct(503, "PROVIDER_RATE_LIMITED", "GitHub is busy right now. Please try again in a few minutes.");
    default:
      return direct(503, "PROVIDER_UNAVAILABLE", "GitHub is unavailable right now. Please try again shortly.");
  }
};
const route = (fn) => async (req, reply) => {
  try {
    return await fn(req, reply);
  } catch (caught) {
    let error = caught instanceof ProviderError ? providerFailure(caught) : caught;
    if (DIRECT_CODES.has(error.code)) error = direct(error.statusCode || 503, error.code, error.message);
    if (!error.direct) throw error;
    if (error.retryAfter) reply.header("Retry-After", String(error.retryAfter));
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, requestId: req.id, ...error.extra } });
  }
};

const sha256 = (value) => createHash("sha256").update(value).digest();
const audit = (client, actor, action, resource) =>
  client.query("INSERT INTO erp.audit_events(actor_id,action,resource_id) VALUES($1,$2,$3)", [actor, action, resource]);
const credentialAccess = (client) => client.query("SELECT set_config('app.credential_access','on',true)");
/** Removes synced data (metrics, repositories, snapshots) and open jobs for one of the student's accounts.
 *  The SQL function checks that the account belongs to the calling student. */
const clearSyncedData = (client, account) =>
  client.query("SELECT student.clear_platform_data($1::uuid)", [account.id]);
/** Creates the profile row if needed and bumps its revision (any onboarding-relevant change). */
const touchProfile = (client, studentId) =>
  client.query(
    `INSERT INTO student.skill_profiles(student_id) VALUES($1)
     ON CONFLICT (student_id) DO UPDATE SET revision=student.skill_profiles.revision+1,updated_at=now()`,
    [studentId],
  );

async function upsertAccount(client, studentId, platform, fields) {
  const { rows } = await client.query(
    `INSERT INTO student.platform_accounts(student_id,platform,state,handle,profile_url,auth_method,ownership,external_id,submitted,visible,sync_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,coalesce($10,true),$11)
     ON CONFLICT (student_id,platform) DO UPDATE SET state=EXCLUDED.state,handle=EXCLUDED.handle,profile_url=EXCLUDED.profile_url,
       auth_method=EXCLUDED.auth_method,ownership=EXCLUDED.ownership,external_id=EXCLUDED.external_id,submitted=EXCLUDED.submitted,
       visible=coalesce($10,student.platform_accounts.visible),sync_status=EXCLUDED.sync_status,sync_error=NULL,
       revision=student.platform_accounts.revision+1,updated_at=now()
     RETURNING *`,
    [
      studentId,
      platform,
      fields.state,
      fields.handle ?? null,
      fields.profileUrl ?? null,
      fields.authMethod,
      fields.ownership,
      fields.externalId ?? null,
      JSON.stringify(fields.submitted ?? {}),
      fields.visible ?? null,
      fields.syncStatus,
    ],
  );
  return rows[0];
}

async function accountResponse(client, account) {
  const metrics = (
    await client.query(
      "SELECT metric,value,verification,method,collected_at,note FROM student.platform_metrics WHERE account_id=$1 ORDER BY metric",
      [account.id],
    )
  ).rows;
  return { data: accountView(account, metrics) };
}

async function onboardingResponse(client, studentId) {
  const profile = (await client.query("SELECT * FROM student.skill_profiles WHERE student_id=$1", [studentId])).rows[0] || null;
  const accounts = (await client.query("SELECT platform,state FROM student.platform_accounts WHERE student_id=$1", [studentId])).rows;
  return {
    data: {
      ...onboardingStatus(profile, accounts),
      visibility: profile?.visibility ?? { platforms: true, projects: true, activity: true, summary: true },
      revision: profile?.revision ?? 0,
    },
  };
}

const lockAccount = async (client, studentId, platform) =>
  (await client.query("SELECT * FROM student.platform_accounts WHERE student_id=$1 AND platform=$2 FOR UPDATE", [studentId, platform])).rows[0];

/** Deletes GitHub credentials (returning the old access cipher for best-effort revocation). */
async function dropCredentials(client, account) {
  await credentialAccess(client);
  const { rows } = await client.query(
    "DELETE FROM student.platform_credentials WHERE account_id=$1 RETURNING kind,access_cipher",
    [account.id],
  );
  return rows[0] || null;
}

const isExternalConflict = (error) =>
  error?.code === "23505" && (error.constraint === "platform_accounts_external" || /platform_accounts_external/.test(error.message || ""));

// ---- Schemas -------------------------------------------------------------------
const revision = z.number().int().min(0).max(2147483647);
const onboardingBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm_identity") }).strict(),
  z
    .object({
      action: z.literal("visibility"),
      visibility: z.object({ platforms: z.boolean(), projects: z.boolean(), activity: z.boolean(), summary: z.boolean() }).strict(),
      revision,
    })
    .strict(),
  z.object({ action: z.literal("complete"), consent: z.literal(true), revision }).strict(),
]);
const platformParams = z.object({ platform: z.enum(PLATFORMS) }).strict();
const platformBody = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("link"), value: z.string().max(300), submitted: z.unknown().optional(), visible: z.boolean().optional() })
    .strict(),
  z.object({ action: z.literal("declare_none") }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
  z.object({ action: z.literal("visibility"), visible: z.boolean() }).strict(),
]);
const callbackBody = z
  .object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), state: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/) })
  .strict();
const tokenBody = z.object({ token: z.string().min(1).max(300) }).strict();
const repoId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,18}$/)]).transform(String);
const featuredBody = z
  .object({ repoIds: z.array(repoId).max(3) })
  .strict()
  .refine((v) => new Set(v.repoIds).size === v.repoIds.length, { message: "Duplicate repositories", path: ["repoIds"] });

const limit = (max) => ({ bodyLimit: 16384, config: { rateLimit: { max, timeWindow: "1 minute" } } });

export function registerStudentSkillRoutes(api, { pool, env = {}, integrations } = {}) {
  const providers = createProviders(env, integrations);
  const { secrets, github } = providers;
  const appConfigured = () => !!(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET && env.GITHUB_OAUTH_REDIRECT_URL);
  const requireSecrets = () => {
    if (!secrets.configured)
      throw direct(503, "INTEGRATIONS_NOT_CONFIGURED", "Platform connections are not configured on this server yet.");
  };
  // github.revoke deletes exactly one access token (DELETE /applications/{id}/token),
  // never the whole grant, so revoking a replaced token cannot touch the token that
  // replaced it or another student's token for the same GitHub account.
  const revokeQuietly = async (credential, accountId, keep = null) => {
    if (!credential || credential.kind !== "github_user_token" || !appConfigured() || !github?.revoke) return;
    try {
      const token = secrets.decrypt(credential.access_cipher, credentialAad(accountId, credential.kind, "access"));
      if (keep && token === keep) return; // the same token is still stored
      await github.revoke(token);
    } catch {
      // Best effort: the local credential is already gone.
    }
  };
  /** Revokes a token that was issued for this request but never stored. */
  const revokeIssued = async (kind, accessToken) => {
    if (kind === "github_user_token" && github?.revoke) await github.revoke(accessToken).catch(() => {});
  };

  // -- Onboarding --------------------------------------------------------------
  api.post("/student/skills/onboarding", limit(30), route(async (req) => {
    const body = onboardingBody.parse(req.body);
    return runStudent(pool, req.actor.id, async (client, official) => {
      const sid = official.id;
      await client.query("INSERT INTO student.skill_profiles(student_id) VALUES($1) ON CONFLICT (student_id) DO NOTHING", [sid]);
      const profile = (await client.query("SELECT * FROM student.skill_profiles WHERE student_id=$1 FOR UPDATE", [sid])).rows[0];
      if (body.action === "confirm_identity") {
        await client.query(
          "UPDATE student.skill_profiles SET identity_confirmed_at=coalesce(identity_confirmed_at,now()),revision=revision+1,updated_at=now() WHERE student_id=$1",
          [sid],
        );
      } else {
        if (profile.revision !== body.revision)
          throw direct(409, "PROFILE_CHANGED", "Your skills profile changed in another tab. Review it and try again.", { revision: profile.revision });
        if (body.action === "visibility") {
          await client.query(
            "UPDATE student.skill_profiles SET visibility=$2::jsonb,visibility_saved_at=now(),revision=revision+1,updated_at=now() WHERE student_id=$1",
            [sid, JSON.stringify(body.visibility)],
          );
        } else {
          const accounts = (await client.query("SELECT platform,state FROM student.platform_accounts WHERE student_id=$1", [sid])).rows;
          const { missing } = onboardingStatus(profile, accounts);
          if (missing.length)
            throw direct(409, "ONBOARDING_INCOMPLETE", "Complete every required section before finishing.", { missing });
          await client.query(
            `UPDATE student.skill_profiles SET onboarding_version=$2,onboarding_completed_at=now(),consent_version=$3,
               consented_at=now(),revision=revision+1,updated_at=now() WHERE student_id=$1`,
            [sid, ONBOARDING_VERSION, CONSENT_VERSION],
          );
          await audit(client, req.actor.id, "skills.onboarding.complete", sid);
        }
      }
      return onboardingResponse(client, sid);
    });
  }));

  // -- GitHub App web flow (PKCE + state) -----------------------------------------
  api.post("/student/skills/platforms/github/authorize", limit(10), route(async (req) => {
    if (!appConfigured() || !github?.authorizeUrl)
      throw direct(503, "GITHUB_APP_NOT_CONFIGURED", "GitHub connection is not configured on this server yet.");
    requireSecrets();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const stateHash = sha256(state).toString("hex");
    const url = github.authorizeUrl({ state, codeChallenge: sha256(verifier).toString("base64url") });
    await runStudent(pool, req.actor.id, async (client, official) => {
      await client.query("DELETE FROM student.oauth_states WHERE user_id=$1 AND (expires_at<now() OR consumed_at IS NOT NULL)", [req.actor.id]);
      // At most five open attempts per user.
      await client.query(
        `DELETE FROM student.oauth_states WHERE user_id=$1 AND state_hash IN
           (SELECT state_hash FROM student.oauth_states WHERE user_id=$1 ORDER BY created_at DESC OFFSET 4)`,
        [req.actor.id],
      );
      await client.query(
        `INSERT INTO student.oauth_states(state_hash,user_id,student_id,verifier_cipher,expires_at)
         VALUES($1,$2,$3,$4,now()+make_interval(mins=>$5))`,
        [stateHash, req.actor.id, official.id, secrets.encrypt(verifier, oauthStateAad(stateHash)), OAUTH_STATE_MINUTES],
      );
    });
    return { data: { url } };
  }));

  async function storeGitHub(req, user, tokens, kind) {
    try {
      return await runStudent(pool, req.actor.id, async (client, official) => {
        const sid = official.id;
        // Serialise concurrent connects for this student: the account row may not
        // exist yet, so a row lock alone cannot stop two inserts racing.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["student.github." + sid]);
        const existing = await lockAccount(client, sid, "github");
        let previous = null;
        if (existing) {
          previous = await dropCredentials(client, existing);
          if (existing.external_id !== String(user.id)) await clearSyncedData(client, existing);
        }
        const account = await upsertAccount(client, sid, "github", {
          state: "linked",
          handle: user.login,
          profileUrl: user.url,
          authMethod: kind === "github_pat" ? "github_pat" : "github_app",
          ownership: "platform_verified",
          externalId: String(user.id),
          submitted: {},
          syncStatus: "pending",
        });
        await credentialAccess(client);
        await client.query(
          `INSERT INTO student.platform_credentials(account_id,kind,key_id,access_cipher,refresh_cipher,access_expires_at,refresh_expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            account.id,
            kind,
            secrets.keyId,
            secrets.encrypt(tokens.accessToken, credentialAad(account.id, kind, "access")),
            tokens.refreshToken ? secrets.encrypt(tokens.refreshToken, credentialAad(account.id, kind, "refresh")) : null,
            tokens.expiresAt ?? null,
            tokens.refreshExpiresAt ?? null,
          ],
        );
        await enqueue(client, account, "connect");
        await touchProfile(client, sid);
        await audit(client, req.actor.id, kind === "github_pat" ? "skills.platform.token" : "skills.platform.connect", account.id);
        const response = await accountResponse(client, account);
        return { response, previous, accountId: account.id };
      });
    } catch (error) {
      // Nothing was stored: revoke only the token issued for this request. The
      // other student's token (same GitHub grant) is untouched.
      if (isExternalConflict(error)) {
        await revokeIssued(kind, tokens.accessToken);
        throw direct(409, "GITHUB_ACCOUNT_IN_USE", "This GitHub account is already linked to another student.");
      }
      if (error?.code === "23505") {
        await revokeIssued(kind, tokens.accessToken);
        throw direct(409, "GITHUB_CONNECT_CONFLICT", "GitHub is already being connected in another tab. Refresh and try again.");
      }
      throw error;
    }
  }

  api.post("/student/skills/platforms/github/callback", limit(10), route(async (req) => {
    const body = callbackBody.parse(req.body);
    if (!appConfigured() || !github?.exchangeCode)
      throw direct(503, "GITHUB_APP_NOT_CONFIGURED", "GitHub connection is not configured on this server yet.");
    requireSecrets();
    const stateHash = sha256(body.state).toString("hex");
    const verifier = await runStudent(pool, req.actor.id, async (client, official) => {
      const row = (await client.query("SELECT * FROM student.oauth_states WHERE state_hash=$1 FOR UPDATE", [stateHash])).rows[0];
      const valid = row && row.user_id === req.actor.id && row.student_id === official.id && !row.consumed_at && new Date(row.expires_at) > new Date();
      if (row) await client.query("UPDATE student.oauth_states SET consumed_at=coalesce(consumed_at,now()) WHERE state_hash=$1", [stateHash]);
      if (!valid) return null;
      return secrets.decrypt(row.verifier_cipher, oauthStateAad(stateHash));
    });
    if (!verifier) throw direct(400, "OAUTH_STATE_INVALID", "This GitHub connection link has expired or was already used. Start again.");
    const tokens = await github.exchangeCode({ code: body.code, codeVerifier: verifier });
    let user;
    try {
      user = await github.user(tokens.accessToken);
    } catch (error) {
      await revokeIssued("github_user_token", tokens.accessToken);
      throw error;
    }
    const { response, previous, accountId } = await storeGitHub(req, user, tokens, "github_user_token");
    // Reconnect: revoke only the replaced token (never the grant, never the new token).
    await revokeQuietly(previous, accountId, tokens.accessToken);
    return response;
  }));

  api.post("/student/skills/platforms/github/token", limit(5), route(async (req) => {
    const { token } = tokenBody.parse(req.body);
    requireSecrets();
    if (!github?.verifyPat) throw direct(503, "PROVIDER_UNAVAILABLE", "GitHub is unavailable right now.");
    const user = await github.verifyPat(token.trim());
    if (user.tokenExpiresAt && new Date(user.tokenExpiresAt) <= new Date())
      throw direct(400, "GITHUB_TOKEN_INVALID", "This token has expired. Create a new fine-grained token.");
    const { response, previous, accountId } = await storeGitHub(
      req,
      user,
      { accessToken: token.trim(), refreshToken: null, expiresAt: user.tokenExpiresAt ?? null, refreshExpiresAt: null },
      "github_pat",
    );
    await revokeQuietly(previous, accountId, token.trim());
    return response;
  }));

  // -- Generic platform actions ------------------------------------------------------
  api.post("/student/skills/platforms/:platform", limit(30), route(async (req) => {
    const { platform } = platformParams.parse(req.params);
    const body = platformBody.parse(req.body);
    if (body.action === "link" && platform === "github")
      throw direct(400, "GITHUB_AUTH_REQUIRED", "Connect GitHub with the GitHub button or a fine-grained token.");
    if (REQUIRED_PLATFORMS.includes(platform) && ["declare_none", "disconnect"].includes(body.action))
      throw direct(409, "REQUIRED_PLATFORM", `${platform === "leetcode" ? "LeetCode" : platform === "linkedin" ? "LinkedIn" : "GitHub"} must remain linked to complete your skills profile.`);
    let normalized, submitted;
    if (body.action === "link") {
      normalized = normalizePlatformValue(platform, body.value);
      if (!normalized) throw direct(400, "INVALID_PLATFORM_HANDLE", "Enter a valid username or profile link for this platform.");
      const checked = validateSubmitted(platform, body.submitted ?? {});
      if (!checked.ok) throw direct(400, "INVALID_SUBMITTED_FIELDS", "Check the figures you entered.", { fields: checked.issues });
      submitted = checked.data;
    }
    const outcome = await runStudent(pool, req.actor.id, async (client, official) => {
      const sid = official.id;
      // Same per-student lock as the GitHub connect paths, so a disconnect cannot interleave with a connect.
      if (platform === "github") await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["student.github." + sid]);
      const existing = await lockAccount(client, sid, platform);
      let previous = null;
      let account;
      if (body.action === "visibility") {
        if (!existing) throw httpError(404, "NOT_FOUND", "This platform has not been set up yet.");
        account = (
          await client.query(
            "UPDATE student.platform_accounts SET visible=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
            [existing.id, body.visible],
          )
        ).rows[0];
      } else if (body.action === "link") {
        const syncs = platform === "huggingface";
        if (existing && existing.handle !== normalized.handle) await clearSyncedData(client, existing);
        account = await upsertAccount(client, sid, platform, {
          state: "linked",
          handle: normalized.handle,
          profileUrl: normalized.profileUrl,
          authMethod: syncs ? "public_api" : "link_only",
          ownership: "student_submitted",
          submitted,
          visible: body.visible,
          syncStatus: syncs ? "pending" : "not_applicable",
        });
        if (syncs) await enqueue(client, account, "connect");
        await audit(client, req.actor.id, "skills.platform.connect", account.id);
      } else {
        if (existing) {
          if (platform === "github") previous = await dropCredentials(client, existing);
          await clearSyncedData(client, existing);
        }
        account = await upsertAccount(client, sid, platform, {
          state: body.action === "declare_none" ? "declared_none" : "disconnected",
          authMethod: "none",
          ownership: "unavailable",
          submitted: {},
          syncStatus: "not_applicable",
        });
        await audit(client, req.actor.id, body.action === "declare_none" ? "skills.platform.declare_none" : "skills.platform.disconnect", account.id);
      }
      await touchProfile(client, sid);
      return { response: await accountResponse(client, account), previous, accountId: account.id };
    });
    await revokeQuietly(outcome.previous, outcome.accountId);
    return outcome.response;
  }));

  api.post("/student/skills/platforms/:platform/refresh", limit(10), route(async (req) => {
    const { platform } = platformParams.parse(req.params);
    return runStudent(pool, req.actor.id, async (client, official) => {
      const account = await lockAccount(client, official.id, platform);
      if (!account || account.state !== "linked" || !SYNCABLE_AUTH.includes(account.auth_method))
        throw direct(409, "NOT_SYNCABLE", "This platform is not synced automatically.");
      if (account.sync_error === "CREDENTIAL_INVALID")
        throw direct(409, "RECONNECT_REQUIRED", "Reconnect this account before refreshing.");
      if (account.manual_refresh_at) {
        const wait = new Date(account.manual_refresh_at).getTime() + REFRESH_LIMIT_MINUTES * 60000 - Date.now();
        if (wait > 0)
          throw Object.assign(direct(429, "REFRESH_LIMIT", "You can refresh this account once every 10 minutes.", { retryAfterSeconds: Math.ceil(wait / 1000) }), {
            retryAfter: Math.ceil(wait / 1000),
          });
      }
      await enqueue(client, account, "manual");
      const updated = (
        await client.query(
          "UPDATE student.platform_accounts SET manual_refresh_at=now(),sync_status='pending',updated_at=now() WHERE id=$1 RETURNING *",
          [account.id],
        )
      ).rows[0];
      await audit(client, req.actor.id, "skills.platform.refresh", account.id);
      return accountResponse(client, updated);
    });
  }));

  // -- Featured projects ---------------------------------------------------------------
  api.post("/student/skills/featured", limit(20), route(async (req) => {
    const { repoIds } = featuredBody.parse(req.body);
    return runStudent(pool, req.actor.id, async (client, official) => {
      const sid = official.id;
      const account = (
        await client.query("SELECT id FROM student.platform_accounts WHERE student_id=$1 AND platform='github' AND state='linked'", [sid])
      ).rows[0];
      if (repoIds.length && !account) throw direct(400, "INVALID_FEATURED", "Connect GitHub before choosing featured projects.");
      const repos = repoIds.length
        ? (
            await client.query(
              "SELECT repo_id::text AS repo_id,name,full_name,url FROM student.github_repositories WHERE student_id=$1 AND account_id=$2 AND repo_id=ANY($3::bigint[])",
              [sid, account.id, repoIds],
            )
          ).rows
        : [];
      if (repos.length !== repoIds.length)
        throw direct(400, "INVALID_FEATURED", "Choose up to three of your own synced GitHub repositories.");
      await client.query("DELETE FROM student.featured_projects WHERE student_id=$1", [sid]);
      for (const [index, id] of repoIds.entries())
        await client.query("INSERT INTO student.featured_projects(student_id,position,account_id,repo_id) VALUES($1,$2,$3,$4)", [
          sid,
          index + 1,
          account.id,
          id,
        ]);
      const byId = new Map(repos.map((r) => [r.repo_id, r]));
      return {
        data: {
          featured: repoIds.map((id, index) => ({
            position: index + 1,
            repoId: id,
            name: byId.get(id).name,
            fullName: byId.get(id).full_name,
            url: byId.get(id).url,
            source: "student_selected",
          })),
        },
      };
    });
  }));
}
