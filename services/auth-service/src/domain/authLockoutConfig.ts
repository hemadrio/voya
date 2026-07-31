/**
 * Auth-service login lockout configuration.
 *
 * ASSUMPTION — values must be ratified by SRE and sponsors before production.
 * Keep in sync with packages/ratelimit/src/config/tiers.ts AUTH_LOCKOUT.
 */
export const AUTH_LOCKOUT = {
  /** Maximum consecutive failed login attempts before account lockout. */
  maxFailures: 5,
  /** Window (ms) for counting failures (15 minutes). */
  windowMs: 15 * 60 * 1000,
  /** Lockout duration (ms) after threshold is reached (15 minutes). */
  lockDurationMs: 15 * 60 * 1000,
} as const;
