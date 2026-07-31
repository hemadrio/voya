/**
 * CredentialService — central password hashing, verification, policy and lockout.
 *
 * All password flows (registration, login, reset) go through this service so
 * algorithm upgrades, cost tuning and policy changes only happen in one place.
 *
 * Hash format (PHC-inspired):
 *   $scrypt$n=<N>,r=<r>,p=<p>,kl=<keyLen>$<hex-salt>$<hex-hash>
 *
 * Algorithm upgrade path:
 *   - verifyPassword detects a hash produced with different parameters
 *     (or the legacy scrypt:<salt>:<hash> format) and sets needsRehash=true.
 *   - The login handler calls hashPassword again and persists the new hash.
 *   - hash_algorithm on the credentials row tracks which algorithm is in use,
 *     enabling bulk migration queries.
 *
 * Timing safety:
 *   - verifyPassword always runs a hash comparison, even when storedHash is
 *     null (unknown user), using a precomputed dummy hash so the response
 *     time is indistinguishable from the existing-user path.
 *
 * Hexagonal architecture: DB operations are injected via CredentialServiceDbClient
 * so unit tests run without a real database.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import type { CredentialServiceConfig } from './credentialServiceConfig.js';

const scryptAsync = promisify(scrypt);

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Returned by verifyPassword and verifyForUser. */
export interface VerifyResult {
  /** Whether the supplied password matched the stored hash. */
  valid: boolean;
  /** True when the stored hash uses outdated parameters — rehash and persist. */
  needsRehash: boolean;
}

/** A single failed password-policy rule. */
export interface PolicyViolation {
  rule: 'MIN_LENGTH' | 'MAX_LENGTH' | 'COMMON_PASSWORD' | 'CONTAINS_EMAIL_LOCAL';
  message: string;
}

/** Returned by validatePasswordPolicy. */
export interface PolicyResult {
  valid: boolean;
  violations: PolicyViolation[];
}

/** Returned by hashPassword. */
export interface HashResult {
  /** PHC-format hash string to persist in credentials.secret_hash. */
  hash: string;
  /** Short algorithm identifier to persist in credentials.hash_algorithm. */
  algorithm: string;
}

/** Returned by recordFailedAttempt. */
export interface LockoutResult {
  locked: boolean;
  failedAttemptCount: number;
  lockedUntil: Date | null;
  retryAfterSeconds: number;
}

/** Returned by isLocked. */
export interface LockStatus {
  locked: boolean;
  /** 0 when not locked. */
  retryAfterSeconds: number;
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export type CredentialErrorKind =
  | 'HASH_FAILURE'
  | 'VERIFY_FAILURE'
  | 'UNKNOWN_HASH_FORMAT'
  | 'CREDENTIAL_NOT_FOUND';

export class CredentialError extends Error {
  readonly kind: CredentialErrorKind;
  readonly operational: boolean;

  constructor(kind: CredentialErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'CredentialError';
    this.kind = kind;
    this.operational = true;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// DB client interface (duck-typed against Prisma)
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: string;
  failedAttemptCount: number;
  lockedUntil: Date | null;
}

type IncrementOp = { increment: number };

interface CredentialUpdateData {
  failedAttemptCount?: number | IncrementOp;
  lockedUntil?: Date | null;
  lastUsedAt?: Date | null;
  secretHash?: string;
  hashAlgorithm?: string;
  updatedAt?: Date;
}

export interface CredentialServiceDbClient {
  credential: {
    findFirst(args: {
      where: { id: string };
      select: { id: true; failedAttemptCount: true; lockedUntil: true };
    }): Promise<CredentialRow | null>;
    update(args: {
      where: { id: string };
      data: CredentialUpdateData;
    }): Promise<CredentialRow>;
  };
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ICredentialService {
  /** Hash a plaintext password and return the PHC-format hash + algorithm. */
  hashPassword(password: string): Promise<HashResult>;

  /**
   * Verify a password against a stored PHC-format hash.
   * Pass null for storedHash to run a dummy comparison (unknown-user path).
   */
  verifyPassword(password: string, storedHash: string | null): Promise<VerifyResult>;

  /** Validate a candidate password against the configured policy. */
  validatePasswordPolicy(password: string, emailLocalPart?: string): PolicyResult;

  /**
   * Atomically increment failed_attempt_count and optionally set locked_until.
   * Throws CredentialError(CREDENTIAL_NOT_FOUND) if no row exists.
   */
  recordFailedAttempt(credentialId: string): Promise<LockoutResult>;

  /** Reset failed_attempt_count to 0 and clear locked_until. */
  resetFailedAttempts(credentialId: string): Promise<void>;

  /** Check whether a credential row is currently locked. */
  isLocked(credentialId: string): Promise<LockStatus>;
}

// ---------------------------------------------------------------------------
// Internal hash helpers
// ---------------------------------------------------------------------------

const HASH_PREFIX = '$scrypt$';
const ALGORITHM_NAME = 'scrypt';

/**
 * Encode scrypt parameters into a PHC-inspired format:
 *   $scrypt$n=<N>,r=<r>,p=<p>,kl=<keyLen>$<hex-salt>$<hex-hash>
 */
function encodeHash(
  params: { N: number; r: number; p: number; keyLen: number },
  saltHex: string,
  hashHex: string,
): string {
  return `${HASH_PREFIX}n=${params.N},r=${params.r},p=${params.p},kl=${params.keyLen}$${saltHex}$${hashHex}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  keyLen: number;
  saltHex: string;
  hashHex: string;
}

function parseHash(storedHash: string): ParsedHash | null {
  if (!storedHash.startsWith(HASH_PREFIX)) return null;
  const body = storedHash.slice(HASH_PREFIX.length);
  const parts = body.split('$');
  if (parts.length !== 3) return null;
  const [paramStr, saltHex, hashHex] = parts as [string, string, string];

  const params: Record<string, number> = {};
  for (const kv of paramStr.split(',')) {
    const eq = kv.indexOf('=');
    if (eq === -1) return null;
    const key = kv.slice(0, eq);
    const val = parseInt(kv.slice(eq + 1), 10);
    if (!isFinite(val)) return null;
    params[key] = val;
  }

  const N = params['n'];
  const r = params['r'];
  const p = params['p'];
  const keyLen = params['kl'];
  if (!N || !r || !p || !keyLen) return null;

  return { N, r, p, keyLen, saltHex, hashHex };
}

async function computeScryptHash(
  password: string,
  saltHex: string,
  params: { N: number; r: number; p: number; keyLen: number },
): Promise<Buffer> {
  const salt = Buffer.from(saltHex, 'hex');
  return (await scryptAsync(password, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
  })) as Buffer;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCredentialService(
  config: CredentialServiceConfig,
  db: CredentialServiceDbClient,
  logger?: { warn(obj: Record<string, unknown>, msg: string): void },
): ICredentialService {
  // Load common-password list once at startup
  let commonPasswords: Set<string>;
  try {
    const raw = readFileSync(config.commonPasswordsPath, 'utf8');
    commonPasswords = new Set(
      raw.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean),
    );
  } catch {
    commonPasswords = new Set();
    logger?.warn(
      { path: config.commonPasswordsPath },
      'common-passwords fixture not found; common-password policy rule disabled',
    );
  }

  // Precompute a dummy hash at construction for unknown-user timing parity.
  // We store the promise so the first call to verifyPassword doesn't pay the
  // extra hash cost — it was paid upfront.
  const dummyHashPromise: Promise<string> = (async () => {
    const saltHex = randomBytes(16).toString('hex');
    const hashBuf = await computeScryptHash('__dummy__', saltHex, config.scrypt);
    return encodeHash(config.scrypt, saltHex, hashBuf.toString('hex'));
  })();

  const CREDENTIAL_SELECT = {
    id: true as const,
    failedAttemptCount: true as const,
    lockedUntil: true as const,
  };

  // ---------------------------------------------------------------------------
  // hashPassword
  // ---------------------------------------------------------------------------

  async function hashPassword(password: string): Promise<HashResult> {
    try {
      const saltHex = randomBytes(16).toString('hex');
      const hashBuf = await computeScryptHash(password, saltHex, config.scrypt);
      return {
        hash: encodeHash(config.scrypt, saltHex, hashBuf.toString('hex')),
        algorithm: ALGORITHM_NAME,
      };
    } catch (err) {
      throw new CredentialError('HASH_FAILURE', 'Failed to hash password', err);
    }
  }

  // ---------------------------------------------------------------------------
  // verifyPassword
  // ---------------------------------------------------------------------------

  async function verifyPassword(
    password: string,
    storedHash: string | null,
  ): Promise<VerifyResult> {
    if (storedHash === null) {
      // Unknown-user path: run dummy comparison to equalize timing.
      try {
        const dummy = await dummyHashPromise;
        const parsed = parseHash(dummy)!;
        const actual = await computeScryptHash(password, parsed.saltHex, config.scrypt);
        const expected = Buffer.from(parsed.hashHex, 'hex');
        if (actual.length === expected.length) {
          timingSafeEqual(actual, expected); // consume time; result discarded
        }
      } catch { /* timing equalization best-effort */ }
      return { valid: false, needsRehash: false };
    }

    // Legacy format check: scrypt:<hex-salt>:<hex-hash>
    if (storedHash.startsWith('scrypt:')) {
      return verifyLegacyScrypt(password, storedHash);
    }

    const parsed = parseHash(storedHash);
    if (!parsed) {
      logger?.warn(
        { hashPrefix: storedHash.slice(0, 16) },
        'Unknown hash format encountered during verification',
      );
      // Run dummy comparison to equalize timing even for corrupted hashes
      try {
        const dummy = await dummyHashPromise;
        const p = parseHash(dummy)!;
        const a = await computeScryptHash(password, p.saltHex, config.scrypt);
        const e = Buffer.from(p.hashHex, 'hex');
        if (a.length === e.length) timingSafeEqual(a, e);
      } catch { /* best-effort */ }
      throw new CredentialError('UNKNOWN_HASH_FORMAT', 'Unrecognized hash format');
    }

    try {
      const actual = await computeScryptHash(password, parsed.saltHex, parsed);
      const expected = Buffer.from(parsed.hashHex, 'hex');
      const valid =
        actual.length === expected.length && timingSafeEqual(actual, expected);

      const needsRehash =
        parsed.N !== config.scrypt.N ||
        parsed.r !== config.scrypt.r ||
        parsed.p !== config.scrypt.p ||
        parsed.keyLen !== config.scrypt.keyLen;

      return { valid, needsRehash };
    } catch (err) {
      throw new CredentialError('VERIFY_FAILURE', 'Hash verification failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Legacy format: scrypt:<hex-salt>:<hex-hash>
  // ---------------------------------------------------------------------------

  async function verifyLegacyScrypt(
    password: string,
    storedHash: string,
  ): Promise<VerifyResult> {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return { valid: false, needsRehash: true };

    const [, saltHex, hashHex] = parts as [string, string, string];
    const LEGACY_KEY_LEN = 64;
    try {
      const actual = (await scryptAsync(password, Buffer.from(saltHex, 'hex'), LEGACY_KEY_LEN, {
        N: 16384, r: 8, p: 1,
      })) as Buffer;
      const expected = Buffer.from(hashHex, 'hex');
      const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
      // Legacy format always needs rehash — upgrade to PHC format on next login
      return { valid, needsRehash: true };
    } catch {
      return { valid: false, needsRehash: true };
    }
  }

  // ---------------------------------------------------------------------------
  // validatePasswordPolicy
  // ---------------------------------------------------------------------------

  function validatePasswordPolicy(
    password: string,
    emailLocalPart?: string,
  ): PolicyResult {
    const violations: PolicyViolation[] = [];

    if (password.length < config.policy.minLength) {
      violations.push({
        rule: 'MIN_LENGTH',
        message: `Password must be at least ${config.policy.minLength} characters`,
      });
    }

    if (password.length > config.policy.maxLength) {
      violations.push({
        rule: 'MAX_LENGTH',
        message: `Password must be at most ${config.policy.maxLength} characters`,
      });
    }

    if (commonPasswords.has(password.toLowerCase())) {
      violations.push({
        rule: 'COMMON_PASSWORD',
        message: 'Password is too common; choose a more unique password',
      });
    }

    if (
      emailLocalPart &&
      emailLocalPart.length > 0 &&
      password.toLowerCase().includes(emailLocalPart.toLowerCase())
    ) {
      violations.push({
        rule: 'CONTAINS_EMAIL_LOCAL',
        message: 'Password must not contain part of your email address',
      });
    }

    return { valid: violations.length === 0, violations };
  }

  // ---------------------------------------------------------------------------
  // recordFailedAttempt
  // ---------------------------------------------------------------------------

  async function recordFailedAttempt(credentialId: string): Promise<LockoutResult> {
    // First read current count to compute the lockout window.
    const existing = await db.credential.findFirst({
      where: { id: credentialId },
      select: CREDENTIAL_SELECT,
    });

    if (!existing) {
      throw new CredentialError(
        'CREDENTIAL_NOT_FOUND',
        `Credential ${credentialId} not found`,
      );
    }

    const newCount = existing.failedAttemptCount + 1;
    const { threshold, baseDelayMs, maxDelayMs } = config.lockout;

    let lockedUntil: Date | null = existing.lockedUntil;
    if (newCount >= threshold) {
      const exponent = newCount - threshold;
      const delayMs = Math.min(baseDelayMs * Math.pow(2, exponent), maxDelayMs);
      lockedUntil = new Date(Date.now() + delayMs);
    }

    const updated = await db.credential.update({
      where: { id: credentialId },
      data: {
        failedAttemptCount: { increment: 1 },
        lockedUntil,
        updatedAt: new Date(),
      },
    });

    const locked = updated.lockedUntil !== null && updated.lockedUntil > new Date();
    const retryAfterSeconds = locked
      ? Math.ceil((updated.lockedUntil!.getTime() - Date.now()) / 1000)
      : 0;

    return {
      locked,
      failedAttemptCount: newCount,
      lockedUntil: updated.lockedUntil,
      retryAfterSeconds,
    };
  }

  // ---------------------------------------------------------------------------
  // resetFailedAttempts
  // ---------------------------------------------------------------------------

  async function resetFailedAttempts(credentialId: string): Promise<void> {
    await db.credential.update({
      where: { id: credentialId },
      data: { failedAttemptCount: 0, lockedUntil: null, updatedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------------------
  // isLocked
  // ---------------------------------------------------------------------------

  async function isLocked(credentialId: string): Promise<LockStatus> {
    const row = await db.credential.findFirst({
      where: { id: credentialId },
      select: CREDENTIAL_SELECT,
    });

    if (!row) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    if (!row.lockedUntil || row.lockedUntil <= new Date()) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    const retryAfterSeconds = Math.ceil(
      (row.lockedUntil.getTime() - Date.now()) / 1000,
    );
    return { locked: true, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  return {
    hashPassword,
    verifyPassword,
    validatePasswordPolicy,
    recordFailedAttempt,
    resetFailedAttempts,
    isLocked,
  };
}
