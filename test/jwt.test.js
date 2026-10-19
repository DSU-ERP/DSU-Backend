import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { verifyAccessToken } from "../src/modules/identity/jwt.js";
test("JWT authentication verifies signatures, issuer, audience, expiry and user role", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const issuer = "https://test.supabase.co/auth/v1";
  const token = (changes = {}, iss = issuer, aud = "authenticated", expiry = "5m") => new SignJWT({ role: "authenticated", ...changes }).setProtectedHeader({ alg: "ES256" }).setSubject("11111111-1111-4111-8111-111111111111").setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  assert.equal((await verifyAccessToken(await token(), publicKey, issuer)).id, "11111111-1111-4111-8111-111111111111");
  await assert.rejects(() => token({}, "https://evil.invalid").then(value => verifyAccessToken(value, publicKey, issuer)));
  await assert.rejects(() => token({}, issuer, "wrong").then(value => verifyAccessToken(value, publicKey, issuer)));
  await assert.rejects(() => token({}, issuer, "authenticated", "-1m").then(value => verifyAccessToken(value, publicKey, issuer)));
  await assert.rejects(() => token({ role: "service_role" }).then(value => verifyAccessToken(value, publicKey, issuer)));
  const other = await generateKeyPair("ES256");
  await assert.rejects(() => token().then(value => verifyAccessToken(value, other.publicKey, issuer)));
});
