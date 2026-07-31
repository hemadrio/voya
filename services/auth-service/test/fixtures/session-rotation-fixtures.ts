/**
 * Session rotation fixtures for WO-022.
 *
 * Provides seeded session chains covering four lifecycle states:
 *   1. active         — valid session that can still be refreshed
 *   2. rotated        — already-rotated session (revokedAt set, has a successor)
 *   3. idle-expired   — expiresAt in the past (idle timeout exceeded)
 *   4. absolute-expired — absoluteExpiresAt in the past (absolute lifetime exceeded)
 *
 * All raw refresh tokens use the same generation logic as production code so
 * the hash relationship holds.  Never use these values in real environments.
 */

import { hashRefreshToken } from "../../src/domain/RefreshService.js";
import type { SessionForRefresh } from "../../src/domain/SessionRepository.js";

// ---------------------------------------------------------------------------
// Time constants
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-31T12:00:00Z");

const FUTURE_IDLE    = new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000);  // 14 days out
const FUTURE_ABS     = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);  // 30 days out
const PAST_IDLE      = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);   // 1 day ago
const PAST_ABS       = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);   // 1 day ago
const PAST_REVOKED   = new Date(NOW.getTime() - 5 * 60 * 1000);              // 5 minutes ago

// ---------------------------------------------------------------------------
// Raw refresh tokens (never use in production — for testing only)
// ---------------------------------------------------------------------------

export const RAW_TOKENS = {
  active:           "active-raw-refresh-token-000000000001",
  rotated:          "rotated-raw-refresh-token-00000000002",
  idleExpired:      "idle-expired-raw-refresh-token-000003",
  absoluteExpired:  "absolute-expired-raw-token-000000004",
} as const;

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

/** Session 1: Active — can be refreshed. */
export const ACTIVE_SESSION: SessionForRefresh = {
  id: "sess-active-0000000000000000001",
  userId: "user-fixture-00000000000000001",
  familyId: "family-000000000000000000001",
  revokedAt: null,
  expiresAt: FUTURE_IDLE,
  absoluteExpiresAt: FUTURE_ABS,
  ipAddress: "10.0.0.1",
  userAgent: "Mozilla/5.0 (fixture)",
};
export const ACTIVE_SESSION_HASH = hashRefreshToken(RAW_TOKENS.active);

/** Session 2: Rotated — revokedAt set, already succeeded by a newer session. */
export const ROTATED_SESSION: SessionForRefresh = {
  id: "sess-rotated-000000000000000002",
  userId: "user-fixture-00000000000000001",
  familyId: "family-000000000000000000001",
  revokedAt: PAST_REVOKED,
  expiresAt: FUTURE_IDLE,
  absoluteExpiresAt: FUTURE_ABS,
  ipAddress: "10.0.0.1",
  userAgent: "Mozilla/5.0 (fixture)",
};
export const ROTATED_SESSION_HASH = hashRefreshToken(RAW_TOKENS.rotated);

/** Session 3: Idle-expired — expiresAt is in the past. */
export const IDLE_EXPIRED_SESSION: SessionForRefresh = {
  id: "sess-idle-exp-00000000000000003",
  userId: "user-fixture-00000000000000002",
  familyId: "family-000000000000000000002",
  revokedAt: null,
  expiresAt: PAST_IDLE,
  absoluteExpiresAt: FUTURE_ABS,
  ipAddress: "10.0.0.2",
  userAgent: "TestApp/2.0 (fixture)",
};
export const IDLE_EXPIRED_SESSION_HASH = hashRefreshToken(RAW_TOKENS.idleExpired);

/** Session 4: Absolute-expired — absoluteExpiresAt is in the past. */
export const ABSOLUTE_EXPIRED_SESSION: SessionForRefresh = {
  id: "sess-abs-exp-000000000000000004",
  userId: "user-fixture-00000000000000002",
  familyId: "family-000000000000000000002",
  revokedAt: null,
  expiresAt: FUTURE_IDLE,
  absoluteExpiresAt: PAST_ABS,
  ipAddress: "10.0.0.2",
  userAgent: "TestApp/2.0 (fixture)",
};
export const ABSOLUTE_EXPIRED_SESSION_HASH = hashRefreshToken(RAW_TOKENS.absoluteExpired);

// ---------------------------------------------------------------------------
// Rotation chain summary (for documentation / seed scripts)
// ---------------------------------------------------------------------------

/**
 * All fixture sessions keyed by lifecycle state.
 * Useful for seeding an in-memory repository in integration tests.
 */
export const SESSION_FIXTURES = {
  active: { session: ACTIVE_SESSION, hash: ACTIVE_SESSION_HASH, rawToken: RAW_TOKENS.active },
  rotated: { session: ROTATED_SESSION, hash: ROTATED_SESSION_HASH, rawToken: RAW_TOKENS.rotated },
  idleExpired: { session: IDLE_EXPIRED_SESSION, hash: IDLE_EXPIRED_SESSION_HASH, rawToken: RAW_TOKENS.idleExpired },
  absoluteExpired: { session: ABSOLUTE_EXPIRED_SESSION, hash: ABSOLUTE_EXPIRED_SESSION_HASH, rawToken: RAW_TOKENS.absoluteExpired },
} as const;
