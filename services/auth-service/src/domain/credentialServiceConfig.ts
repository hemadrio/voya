/**
 * Configuration for CredentialService — hash cost parameters, policy bounds,
 * and lockout settings.
 *
 * Production values are the defaults.  Test environments set
 * CREDENTIAL_TEST_MODE=1 to get cheap parameters so suites run quickly
 * without sacrificing correctness.
 *
 * Production floors (must never be overridden downward in production):
 *   scrypt: N >= 16384 (2^14), r >= 8, p >= 1
 *   argon2id: memoryCost >= 65536 kB (64 MB), timeCost >= 3
 */

export interface ScryptParams {
  /** CPU/memory cost — must be a power of 2 and >= 16384 in production. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelism factor. */
  p: number;
  /** Output key length in bytes. */
  keyLen: number;
}

export interface LockoutConfig {
  /**
   * Number of consecutive failures before the first lockout.
   * Default 5.
   */
  threshold: number;
  /**
   * Base lockout duration in milliseconds.
   * Actual duration = min(baseDelayMs * 2^(failureCount - threshold), maxDelayMs).
   * Default 5 minutes.
   */
  baseDelayMs: number;
  /** Maximum lockout duration. Default 24 hours. */
  maxDelayMs: number;
}

export interface PasswordPolicyConfig {
  /** Minimum length in UTF-16 code units. Default 12. */
  minLength: number;
  /**
   * Maximum length to prevent DoS on intentionally huge inputs.
   * Default 128.
   */
  maxLength: number;
}

export interface CredentialServiceConfig {
  scrypt: ScryptParams;
  lockout: LockoutConfig;
  policy: PasswordPolicyConfig;
  /** Path to the newline-delimited common-password list. */
  commonPasswordsPath: string;
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

const PROD_DEFAULTS: CredentialServiceConfig = {
  scrypt: {
    N: 32768, // 2^15 — OWASP minimum * 2
    r: 8,
    p: 1,
    keyLen: 64,
  },
  lockout: {
    threshold: 5,
    baseDelayMs: 5 * 60 * 1000,   // 5 minutes
    maxDelayMs: 24 * 60 * 60 * 1000, // 24 hours
  },
  policy: {
    minLength: 12,
    maxLength: 128,
  },
  commonPasswordsPath: new URL(
    '../../test/fixtures/common-passwords.txt',
    import.meta.url,
  ).pathname,
};

// ---------------------------------------------------------------------------
// Test defaults (cheap — keeps suites fast)
// ---------------------------------------------------------------------------

const TEST_DEFAULTS: CredentialServiceConfig = {
  ...PROD_DEFAULTS,
  scrypt: {
    N: 1024, // 2^10 — fast but still valid
    r: 8,
    p: 1,
    keyLen: 64,
  },
};

// ---------------------------------------------------------------------------
// Environment-aware factory
// ---------------------------------------------------------------------------

/**
 * Returns the configuration appropriate for the current environment.
 * Merge your own overrides on top of the returned object.
 */
export function loadCredentialServiceConfig(
  overrides?: Partial<CredentialServiceConfig>,
): CredentialServiceConfig {
  const isTest = process.env['NODE_ENV'] === 'test' ||
    process.env['CREDENTIAL_TEST_MODE'] === '1';
  const base = isTest ? TEST_DEFAULTS : PROD_DEFAULTS;
  return { ...base, ...overrides };
}
