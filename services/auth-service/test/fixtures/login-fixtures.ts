/**
 * Login fixtures — pre-seeded users and tokens for login integration tests.
 *
 * All tokens here are:
 *   - HS256-signed with the TEST_JWT_SECRET constant below
 *   - Intended for test environments ONLY — never use in production
 *
 * Usage:
 *   import { VERIFIED_USER, TAMPERED_ACCESS_TOKEN } from './login-fixtures.js';
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Test signing material — TEST ONLY, never used outside unit/integration tests
// ---------------------------------------------------------------------------

export const TEST_JWT_SECRET = "test-jwt-secret-for-login-fixtures-only-32c";
export const TEST_JWT_KID = "test-k1";
export const TEST_JWT_ISSUER = "https://auth.test.local";
export const TEST_JWT_AUDIENCE = "https://api.test.local";
export const TEST_JWT_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// User fixture definitions
// ---------------------------------------------------------------------------

/** A verified, active user — should log in successfully. */
export const VERIFIED_USER = {
  email: "verified@example.com",
  password: "Verified1!",
  firstName: "Verified",
  lastName: "User",
} as const;

/** An unverified user — created but email not confirmed. */
export const UNVERIFIED_USER = {
  email: "unverified@example.com",
  password: "Unverified1!",
  firstName: "Unverified",
  lastName: "User",
} as const;

/** A suspended user — account is disabled. */
export const SUSPENDED_USER = {
  email: "suspended@example.com",
  password: "Suspended1!",
  firstName: "Suspended",
  lastName: "User",
} as const;

// ---------------------------------------------------------------------------
// Pre-generated JWT token fixtures
// ---------------------------------------------------------------------------

/** Internal helper: base64url-encode a Buffer. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Internal helper: build an HS256 JWT. */
function makeToken(
  payload: Record<string, unknown>,
  secret: string = TEST_JWT_SECRET,
  kid: string = TEST_JWT_KID,
): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(
    createHmac("sha256", secret)
      .update(`${header}.${body}`)
      .digest(),
  );
  return `${header}.${body}.${sig}`;
}

/** An expired access token (exp = 1970-01-01, i.e. always in the past). */
export const EXPIRED_ACCESS_TOKEN = makeToken({
  sub: "user-expired",
  sid: "session-expired",
  iss: TEST_JWT_ISSUER,
  aud: TEST_JWT_AUDIENCE,
  iat: 1,
  exp: 1,   // Unix epoch — always expired
  jti: "jti-expired",
  roles: ["user"],
});

/** A token signed with a different secret — signature verification must fail. */
export const TAMPERED_ACCESS_TOKEN = (() => {
  // Sign with correct secret, then flip one byte in the signature.
  const token = makeToken({
    sub: "user-tampered",
    sid: "session-tampered",
    iss: TEST_JWT_ISSUER,
    aud: TEST_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: "jti-tampered",
    roles: ["user"],
  });
  const parts = token.split(".");
  // Corrupt the last character of the signature.
  const corrupted = parts[2]!.slice(0, -1) + (parts[2]!.endsWith("a") ? "b" : "a");
  return `${parts[0]}.${parts[1]}.${corrupted}`;
})();

/** A token with a valid signature but wrong issuer. */
export const WRONG_ISSUER_TOKEN = makeToken({
  sub: "user-wrong-iss",
  sid: "session-wrong-iss",
  iss: "https://evil.attacker.example.com",
  aud: TEST_JWT_AUDIENCE,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
  jti: "jti-wrong-iss",
  roles: ["user"],
});

/** A token where the header claims alg=none — must be rejected even with valid HS256 signature. */
export const NONE_ALG_TOKEN = (() => {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: TEST_JWT_KID })));
  const body = b64url(Buffer.from(JSON.stringify({
    sub: "user-none",
    sid: "session-none",
    iss: TEST_JWT_ISSUER,
    aud: TEST_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: "jti-none",
    roles: [],
  })));
  return `${header}.${body}.`;  // No signature (none algorithm pattern)
})();
