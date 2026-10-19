import { createRemoteJWKSet, decodeProtectedHeader } from "jose";
import { verifyAccessToken } from "./jwt.js";
import { z } from "zod";
import { httpError } from "../../platform/http/errors.js";
export function authVerifier(env) {
  let keys;
  return async (token) => {
    let algorithm;
    try {
      algorithm = decodeProtectedHeader(token).alg;
    } catch {
      throw httpError(401, "UNAUTHENTICATED", "Please sign in again.");
    }
    if (algorithm === "ES256" || algorithm === "RS256") {
      const issuer = env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1";
      keys ||= createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"), {
        cacheMaxAge: 600000,
        timeoutDuration: 5000,
      });
      try {
        return await verifyAccessToken(token, keys, issuer);
      } catch (error) {
        if (error.code === "ERR_JWKS_TIMEOUT" || error.name === "TypeError")
          throw httpError(
            503,
            "AUTH_UNAVAILABLE",
            "Authentication is temporarily unavailable.",
          );
        throw httpError(401, "UNAUTHENTICATED", "Please sign in again.");
      }
    }
    if (algorithm !== "HS256")
      throw httpError(401, "UNAUTHENTICATED", "Please sign in again.");
    // Legacy symmetric tokens are verified by Supabase; no JWT secret is copied here.
    let response;
    try {
      response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw httpError(
        503,
        "AUTH_UNAVAILABLE",
        "Authentication is temporarily unavailable.",
      );
    }
    if (response.status >= 500 || response.status === 429)
      throw httpError(
        503,
        "AUTH_UNAVAILABLE",
        "Authentication is temporarily unavailable.",
      );
    if (!response.ok)
      throw httpError(401, "UNAUTHENTICATED", "Please sign in again.");
    const user = await response.json();
    if (!z.uuid().safeParse(user.id).success)
      throw httpError(401, "UNAUTHENTICATED", "Please sign in again.");
    return { id: user.id };
  };
}
