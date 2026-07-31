/**
 * Principal and token fixtures for WO-023 unit and integration tests.
 *
 * Provides ready-made principals and token claim sets for the four canonical
 * test scenarios: anonymous, standard user, admin, and revoked-session.
 */

import type { TokenClaims } from "../../src/domain/TokenService.js";

// ---------------------------------------------------------------------------
// Now constant for deterministic tests
// ---------------------------------------------------------------------------

const FIXTURE_NOW_S = Math.floor(new Date("2026-07-31T12:00:00Z").getTime() / 1000);

// ---------------------------------------------------------------------------
// Token claims builders
// ---------------------------------------------------------------------------

/** Standard authenticated user token claims. */
export const USER_TOKEN_CLAIMS: TokenClaims = {
  sub: "user-fixture-00000000000000001",
  sid: "sess-fixture-00000000000000001",
  jti: "jti-fixture-000000000000000001",
  iss: "auth-service",
  aud: "travel-api",
  iat: FIXTURE_NOW_S,
  exp: FIXTURE_NOW_S + 900,
  roles: ["user"],
};

/** Admin user token claims. */
export const ADMIN_TOKEN_CLAIMS: TokenClaims = {
  sub: "user-fixture-00000000000000002",
  sid: "sess-fixture-00000000000000002",
  jti: "jti-fixture-000000000000000002",
  iss: "auth-service",
  aud: "travel-api",
  iat: FIXTURE_NOW_S,
  exp: FIXTURE_NOW_S + 900,
  roles: ["user", "admin"],
};

/** Revoked-session token claims — JWT still valid but session row is revoked. */
export const REVOKED_SESSION_TOKEN_CLAIMS: TokenClaims = {
  sub: "user-fixture-00000000000000003",
  sid: "sess-fixture-00000000000000003-revoked",
  jti: "jti-fixture-000000000000000003",
  iss: "auth-service",
  aud: "travel-api",
  iat: FIXTURE_NOW_S - 300,
  exp: FIXTURE_NOW_S + 600,
  roles: ["user"],
};

// ---------------------------------------------------------------------------
// RequestPrincipal builders
// ---------------------------------------------------------------------------

/** Standard user principal — has "user" role, no special permissions. */
export const USER_PRINCIPAL = {
  userId: USER_TOKEN_CLAIMS.sub,
  sessionId: USER_TOKEN_CLAIMS.sid,
  tokenId: USER_TOKEN_CLAIMS.jti,
  roles: ["user"],
  permissions: [],
} as const;

/** Admin principal — has "user" and "admin" roles. */
export const ADMIN_PRINCIPAL = {
  userId: ADMIN_TOKEN_CLAIMS.sub,
  sessionId: ADMIN_TOKEN_CLAIMS.sid,
  tokenId: ADMIN_TOKEN_CLAIMS.jti,
  roles: ["user", "admin"],
  permissions: ["user:read", "user:write", "user:delete", "booking:read", "booking:write"],
} as const;

/** Anonymous principal — no userId/session (optionalAuth route). */
export const ANONYMOUS = undefined;

/** Revoked-session principal snapshot (claims still technically valid). */
export const REVOKED_SESSION_PRINCIPAL = {
  userId: REVOKED_SESSION_TOKEN_CLAIMS.sub,
  sessionId: REVOKED_SESSION_TOKEN_CLAIMS.sid,
  tokenId: REVOKED_SESSION_TOKEN_CLAIMS.jti,
  roles: ["user"],
  permissions: [],
} as const;
