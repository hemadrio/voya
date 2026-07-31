/**
 * Registration fixtures — deterministic request bodies and pre-seeded
 * one-time token records for registration and email-verification tests.
 *
 * Raw tokens are exposed here ONLY for test assertions; in production the
 * raw token is never persisted and is delivered to the user via email only.
 *
 * Usage:
 *   import { VALID_REGISTER_REQUEST, EXPIRED_VERIFICATION_TOKEN } from './registration-fixtures.js';
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Registration request fixtures
// ---------------------------------------------------------------------------

/** A fully-valid registration payload for Alice. */
export const VALID_REGISTER_REQUEST = {
  email: "alice@example.com",
  password: "Password1!",
  firstName: "Alice",
  lastName: "Smith",
} as const;

/** A registration payload with a weak password (fails Zod schema). */
export const WEAK_PASSWORD_REQUEST = {
  email: "bob@example.com",
  password: "weak",
  firstName: "Bob",
  lastName: "Jones",
} as const;

/** A registration payload with an invalid email (fails Zod schema). */
export const INVALID_EMAIL_REQUEST = {
  email: "not-an-email",
  password: "Password1!",
  firstName: "Bob",
  lastName: "Jones",
} as const;

/** A registration payload with an extra field (rejected by strict schema). */
export const EXTRA_FIELD_REQUEST = {
  email: "dave@example.com",
  password: "Password1!",
  firstName: "Dave",
  lastName: "Brown",
  injected: "evil",
} as const;

// ---------------------------------------------------------------------------
// Token fixtures — deterministic raw tokens for integration seeding
// ---------------------------------------------------------------------------

/** A raw verification token that has NOT yet been consumed (valid, non-expired). */
export const VALID_RAW_TOKEN = "valid-verification-token-32bytes-xx";

/** SHA-256 hash of VALID_RAW_TOKEN — stored in the DB. */
export const VALID_TOKEN_HASH = createHash("sha256")
  .update(VALID_RAW_TOKEN)
  .digest("hex");

/** A raw token that is already expired (seeded with expiresAt in the past). */
export const EXPIRED_RAW_TOKEN = "expired-verification-token-32bytes";

/** SHA-256 hash of EXPIRED_RAW_TOKEN. */
export const EXPIRED_TOKEN_HASH = createHash("sha256")
  .update(EXPIRED_RAW_TOKEN)
  .digest("hex");

/** A raw token that has already been consumed (seeded with consumedAt set). */
export const CONSUMED_RAW_TOKEN = "consumed-verification-token-32bytes";

/** SHA-256 hash of CONSUMED_RAW_TOKEN. */
export const CONSUMED_TOKEN_HASH = createHash("sha256")
  .update(CONSUMED_RAW_TOKEN)
  .digest("hex");

// ---------------------------------------------------------------------------
// Pre-seeded DB records for integration tests
// ---------------------------------------------------------------------------

/** An expired one-time-token record — for seeding the DB in integration tests. */
export function makeExpiredTokenRecord(userId: string) {
  return {
    purpose: "email_verification" as const,
    tokenHash: EXPIRED_TOKEN_HASH,
    expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
    consumedAt: null,
    userId,
  };
}

/** A consumed one-time-token record — for seeding the DB in integration tests. */
export function makeConsumedTokenRecord(userId: string) {
  return {
    purpose: "email_verification" as const,
    tokenHash: CONSUMED_TOKEN_HASH,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // still within window
    consumedAt: new Date(Date.now() - 60 * 1000), // consumed 1 minute ago
    userId,
  };
}

/** A valid (non-expired, non-consumed) token record — for seeding. */
export function makeValidTokenRecord(userId: string) {
  return {
    purpose: "email_verification" as const,
    tokenHash: VALID_TOKEN_HASH,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    consumedAt: null,
    userId,
  };
}
