import { jwtVerify } from "jose";
import { z } from "zod";
export async function verifyAccessToken(token, keys, issuer) {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: "authenticated",
    algorithms: ["ES256", "RS256"],
    requiredClaims: ["sub", "exp", "iat"],
  });
  if (
    !z.uuid().safeParse(payload.sub).success ||
    payload.role !== "authenticated"
  )
    throw new Error("Invalid user claims");
  return { id: payload.sub };
}
