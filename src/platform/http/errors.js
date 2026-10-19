import { timingSafeEqual } from "node:crypto";
export function httpError(statusCode, code, message) {
  // `expose` marks messages written for end users (safe to return on 4xx).
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}
// Missing relation/function/column/schema: the code is newer than the database.
const pendingMigrationCodes = new Set(["42P01", "42883", "42703", "3F000"]);
export function isPendingMigration(error) {
  return pendingMigrationCodes.has(error?.code);
}
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function databaseError(error) {
  const statuses = {
    PT400: 400,
    PT401: 401,
    PT403: 403,
    PT404: 404,
    PT409: 409,
    PT413: 413,
    PT429: 429,
  };
  const status = statuses[error.code];
  return status ? httpError(status, error.code, error.message) : error;
}
