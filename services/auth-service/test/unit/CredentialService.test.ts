/**
 * Unit tests for CredentialService.
 *
 * Uses a tiny scrypt cost (N=1024) so tests run fast while still exercising
 * real hash operations.  DB operations are mocked.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCredentialService,
  CredentialError,
  type ICredentialService,
  type CredentialServiceDbClient,
} from '../../src/domain/CredentialService.js';
import type { CredentialServiceConfig } from '../../src/domain/credentialServiceConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test config — cheap scrypt so tests run in < 100ms
// ---------------------------------------------------------------------------

const TEST_CONFIG: CredentialServiceConfig = {
  scrypt: { N: 1024, r: 8, p: 1, keyLen: 64 },
  lockout: { threshold: 5, baseDelayMs: 60_000, maxDelayMs: 24 * 60 * 60 * 1000 },
  policy: { minLength: 12, maxLength: 128 },
  commonPasswordsPath: join(__dirname, '../fixtures/common-passwords.txt'),
};

// ---------------------------------------------------------------------------
// Mock DB client
// ---------------------------------------------------------------------------

function makeDb(overrides: Partial<CredentialServiceDbClient['credential']> = {}): CredentialServiceDbClient {
  const defaultRow = {
    id: 'cred-1',
    failedAttemptCount: 0,
    lockedUntil: null as Date | null,
  };
  return {
    credential: {
      findFirst: vi.fn(async () => defaultRow),
      update: vi.fn(async (args: { data: { failedAttemptCount?: number | { increment: number }; lockedUntil?: Date | null } }) => {
        const count = typeof args.data.failedAttemptCount === 'object'
          ? defaultRow.failedAttemptCount + args.data.failedAttemptCount.increment
          : (args.data.failedAttemptCount ?? defaultRow.failedAttemptCount);
        return {
          ...defaultRow,
          failedAttemptCount: count,
          lockedUntil: args.data.lockedUntil !== undefined
            ? args.data.lockedUntil
            : defaultRow.lockedUntil,
        };
      }),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// hashPassword
// ---------------------------------------------------------------------------

describe('CredentialService.hashPassword', () => {
  let svc: ICredentialService;

  beforeAll(() => {
    svc = createCredentialService(TEST_CONFIG, makeDb());
  });

  it('returns a PHC-format hash starting with $scrypt$', async () => {
    const result = await svc.hashPassword('SuperSecure$Pass1');
    expect(result.hash).toMatch(/^\$scrypt\$/);
  });

  it('records algorithm as scrypt', async () => {
    const result = await svc.hashPassword('SuperSecure$Pass1');
    expect(result.algorithm).toBe('scrypt');
  });

  it('produces unique hashes for the same password (different salts)', async () => {
    const r1 = await svc.hashPassword('SuperSecure$Pass1');
    const r2 = await svc.hashPassword('SuperSecure$Pass1');
    expect(r1.hash).not.toBe(r2.hash);
  });

  it('embeds current cost parameters in the hash string', async () => {
    const result = await svc.hashPassword('SuperSecure$Pass1');
    expect(result.hash).toContain('n=1024');
    expect(result.hash).toContain('r=8');
    expect(result.hash).toContain('p=1');
    expect(result.hash).toContain('kl=64');
  });
});

// ---------------------------------------------------------------------------
// verifyPassword — correct password
// ---------------------------------------------------------------------------

describe('CredentialService.verifyPassword — round trip', () => {
  let svc: ICredentialService;
  let storedHash: string;

  beforeAll(async () => {
    svc = createCredentialService(TEST_CONFIG, makeDb());
    const result = await svc.hashPassword('GoodPassword!99');
    storedHash = result.hash;
  });

  it('returns valid=true for the correct password', async () => {
    const result = await svc.verifyPassword('GoodPassword!99', storedHash);
    expect(result.valid).toBe(true);
  });

  it('returns valid=false for wrong password', async () => {
    const result = await svc.verifyPassword('WrongPassword!', storedHash);
    expect(result.valid).toBe(false);
  });

  it('returns needsRehash=false when parameters match config', async () => {
    const result = await svc.verifyPassword('GoodPassword!99', storedHash);
    expect(result.needsRehash).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyPassword — needsRehash detection
// ---------------------------------------------------------------------------

describe('CredentialService.verifyPassword — needsRehash', () => {
  it('detects outdated parameters and sets needsRehash=true', async () => {
    // Hash with low-cost config
    const lowCostConfig: CredentialServiceConfig = {
      ...TEST_CONFIG,
      scrypt: { N: 512, r: 8, p: 1, keyLen: 64 },
    };
    const lowCostSvc = createCredentialService(lowCostConfig, makeDb());
    const { hash: oldHash } = await lowCostSvc.hashPassword('GoodPassword!99');

    // Verify under higher-cost config
    const svc = createCredentialService(TEST_CONFIG, makeDb());
    const result = await svc.verifyPassword('GoodPassword!99', oldHash);

    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it('sets needsRehash=true for legacy scrypt format', async () => {
    // Produce a legacy-format hash
    const { scrypt: crypto } = await import('node:crypto');
    const { promisify } = await import('node:util');
    const { randomBytes } = await import('node:crypto');
    const scryptAsync = promisify(crypto);
    const salt = randomBytes(16);
    const hash = await scryptAsync('GoodPassword!99', salt, 64, { N: 16384, r: 8, p: 1 }) as Buffer;
    const legacyHash = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;

    const svc = createCredentialService(TEST_CONFIG, makeDb());
    const result = await svc.verifyPassword('GoodPassword!99', legacyHash);

    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyPassword — unknown user (null hash)
// ---------------------------------------------------------------------------

describe('CredentialService.verifyPassword — unknown user', () => {
  it('returns valid=false for null storedHash (unknown user)', async () => {
    const svc = createCredentialService(TEST_CONFIG, makeDb());
    const result = await svc.verifyPassword('SomePassword!1', null);
    expect(result.valid).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it('timing: unknown-user path completes within 3x existing-user median', async () => {
    const svc = createCredentialService(TEST_CONFIG, makeDb());
    const { hash: storedHash } = await svc.hashPassword('TimingTestPass!1');

    // Warm up
    await svc.verifyPassword('TimingTestPass!1', storedHash);
    await svc.verifyPassword('TimingTestPass!1', null);

    const ITERATIONS = 5;
    let existingTotal = 0;
    let unknownTotal = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = Date.now();
      await svc.verifyPassword('TimingTestPass!1', storedHash);
      existingTotal += Date.now() - t0;

      const t1 = Date.now();
      await svc.verifyPassword('TimingTestPass!1', null);
      unknownTotal += Date.now() - t1;
    }

    const existingMedian = existingTotal / ITERATIONS;
    const unknownMedian = unknownTotal / ITERATIONS;

    // The unknown-user path should be within 300% of existing-user (generous tolerance for test env)
    const ratio = unknownMedian / existingMedian;
    expect(ratio).toBeLessThan(3.0);
  });
});

// ---------------------------------------------------------------------------
// validatePasswordPolicy
// ---------------------------------------------------------------------------

describe('CredentialService.validatePasswordPolicy', () => {
  let svc: ICredentialService;

  beforeAll(() => {
    svc = createCredentialService(TEST_CONFIG, makeDb());
  });

  it('accepts a valid password', () => {
    const result = svc.validatePasswordPolicy('ValidPass@word99');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects passwords shorter than minLength (11 chars → fail)', () => {
    const result = svc.validatePasswordPolicy('Short1234!A');  // 11 chars
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.rule === 'MIN_LENGTH')).toBe(true);
  });

  it('accepts passwords exactly at minLength (12 chars → pass)', () => {
    const result = svc.validatePasswordPolicy('Short1234!AB');  // 12 chars
    const minViolation = result.violations.find(v => v.rule === 'MIN_LENGTH');
    expect(minViolation).toBeUndefined();
  });

  it('accepts passwords exactly at maxLength (128 chars → pass)', () => {
    const password = 'A'.repeat(128);
    const result = svc.validatePasswordPolicy(password);
    const maxViolation = result.violations.find(v => v.rule === 'MAX_LENGTH');
    expect(maxViolation).toBeUndefined();
  });

  it('rejects passwords longer than maxLength (129 chars → fail)', () => {
    const password = 'A'.repeat(129);
    const result = svc.validatePasswordPolicy(password);
    expect(result.violations.some(v => v.rule === 'MAX_LENGTH')).toBe(true);
  });

  it('rejects common passwords (case-insensitive)', () => {
    const result = svc.validatePasswordPolicy('PASSWORD123');
    expect(result.violations.some(v => v.rule === 'COMMON_PASSWORD')).toBe(true);
  });

  it('rejects passwords containing email local part', () => {
    const result = svc.validatePasswordPolicy('alice_secure!99', 'alice');
    expect(result.violations.some(v => v.rule === 'CONTAINS_EMAIL_LOCAL')).toBe(true);
  });

  it('email local part check is case-insensitive', () => {
    const result = svc.validatePasswordPolicy('ALICE_secure!99', 'alice');
    expect(result.violations.some(v => v.rule === 'CONTAINS_EMAIL_LOCAL')).toBe(true);
  });

  it('returns multiple violations when applicable', () => {
    const result = svc.validatePasswordPolicy('pass');  // too short + common
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });

  it('does not run email check when emailLocalPart is undefined', () => {
    const result = svc.validatePasswordPolicy('ValidPass@word99');
    const emailViolation = result.violations.find(v => v.rule === 'CONTAINS_EMAIL_LOCAL');
    expect(emailViolation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordFailedAttempt
// ---------------------------------------------------------------------------

describe('CredentialService.recordFailedAttempt', () => {
  it('increments failedAttemptCount', async () => {
    const db = makeDb({
      findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 2, lockedUntil: null })),
      update: vi.fn(async (args: { data: { failedAttemptCount?: number | { increment: number }; lockedUntil?: Date | null } }) => ({
        id: 'cred-1',
        failedAttemptCount: 3,
        lockedUntil: args.data.lockedUntil ?? null,
      })),
    });
    const svc = createCredentialService(TEST_CONFIG, db);

    const result = await svc.recordFailedAttempt('cred-1');

    expect(result.failedAttemptCount).toBe(3);
  });

  it('sets locked=false before threshold is reached', async () => {
    const db = makeDb({
      findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 3, lockedUntil: null })),
      update: vi.fn(async (args: { data: { lockedUntil?: Date | null } }) => ({
        id: 'cred-1',
        failedAttemptCount: 4,
        lockedUntil: args.data.lockedUntil ?? null,
      })),
    });
    const svc = createCredentialService(TEST_CONFIG, db);

    const result = await svc.recordFailedAttempt('cred-1');

    expect(result.locked).toBe(false);
  });

  it('locks at threshold with base delay', async () => {
    // failedAttemptCount is 4, so next attempt (count=5) hits threshold
    let capturedLockedUntil: Date | null = null;
    const db = makeDb({
      findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 4, lockedUntil: null })),
      update: vi.fn(async (args: { data: { lockedUntil?: Date | null } }) => {
        capturedLockedUntil = args.data.lockedUntil ?? null;
        return {
          id: 'cred-1',
          failedAttemptCount: 5,
          lockedUntil: capturedLockedUntil,
        };
      }),
    });
    const svc = createCredentialService(TEST_CONFIG, db);

    const result = await svc.recordFailedAttempt('cred-1');

    expect(result.locked).toBe(true);
    expect(result.lockedUntil).not.toBeNull();
  });

  it('uses exponential backoff beyond threshold', async () => {
    // count goes from 6 → 7 (2 steps above threshold)
    // delay = baseDelayMs * 2^(7-5) = 60000 * 4 = 240000ms
    let capturedLockedUntil: Date | null = null;
    const db = makeDb({
      findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 6, lockedUntil: null })),
      update: vi.fn(async (args: { data: { lockedUntil?: Date | null } }) => {
        capturedLockedUntil = args.data.lockedUntil ?? null;
        return {
          id: 'cred-1',
          failedAttemptCount: 7,
          lockedUntil: capturedLockedUntil,
        };
      }),
    });
    const svc = createCredentialService(TEST_CONFIG, db);

    await svc.recordFailedAttempt('cred-1');

    // newCount=7, exponent=7-5=2, delay=60000*4=240000ms
    const expectedDelayMs = TEST_CONFIG.lockout.baseDelayMs * Math.pow(2, 2);
    const expectedLockedUntil = Date.now() + expectedDelayMs;
    const diff = Math.abs(capturedLockedUntil!.getTime() - expectedLockedUntil);
    expect(diff).toBeLessThan(500); // within 500ms tolerance
  });

  it('caps lockout at maxDelayMs', async () => {
    // Very high count so base * 2^exp would exceed max
    let capturedLockedUntil: Date | null = null;
    const db = makeDb({
      findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 100, lockedUntil: null })),
      update: vi.fn(async (args: { data: { lockedUntil?: Date | null } }) => {
        capturedLockedUntil = args.data.lockedUntil ?? null;
        return { id: 'cred-1', failedAttemptCount: 101, lockedUntil: capturedLockedUntil };
      }),
    });
    const svc = createCredentialService(TEST_CONFIG, db);

    await svc.recordFailedAttempt('cred-1');

    const maxLockedUntil = Date.now() + TEST_CONFIG.lockout.maxDelayMs;
    expect(capturedLockedUntil!.getTime()).toBeLessThanOrEqual(maxLockedUntil + 500);
  });

  it('throws CredentialError(CREDENTIAL_NOT_FOUND) when row missing', async () => {
    const db = makeDb({ findFirst: vi.fn(async () => null) });
    const svc = createCredentialService(TEST_CONFIG, db);

    await expect(svc.recordFailedAttempt('no-such-id')).rejects.toThrow(CredentialError);
    await expect(svc.recordFailedAttempt('no-such-id')).rejects.toMatchObject({
      kind: 'CREDENTIAL_NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// resetFailedAttempts
// ---------------------------------------------------------------------------

describe('CredentialService.resetFailedAttempts', () => {
  it('calls db.update with failedAttemptCount=0 and lockedUntil=null', async () => {
    const db = makeDb();
    const svc = createCredentialService(TEST_CONFIG, db);

    await svc.resetFailedAttempts('cred-1');

    expect(db.credential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cred-1' },
        data: expect.objectContaining({ failedAttemptCount: 0, lockedUntil: null }),
      }),
    );
  });

  it('resolves without returning a value', async () => {
    const svc = createCredentialService(TEST_CONFIG, makeDb());
    await expect(svc.resetFailedAttempts('cred-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isLocked
// ---------------------------------------------------------------------------

describe('CredentialService.isLocked', () => {
  it('returns locked=false when no lockedUntil', async () => {
    const db = makeDb({ findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 0, lockedUntil: null })) });
    const svc = createCredentialService(TEST_CONFIG, db);

    const result = await svc.isLocked('cred-1');

    expect(result.locked).toBe(false);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('returns locked=true when lockedUntil is in the future', async () => {
    const future = new Date(Date.now() + 60_000);
    const db = makeDb({ findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 5, lockedUntil: future })) });
    const svc = createCredentialService(TEST_CONFIG, db);

    const result = await svc.isLocked('cred-1');

    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('returns locked=false when lockedUntil is in the past (clock skew handling)', async () => {
    const past = new Date(Date.now() - 1000);
    const db = makeDb({ findFirst: vi.fn(async () => ({ id: 'cred-1', failedAttemptCount: 5, lockedUntil: past })) });
    const svc = createCredentialService(TEST_CONFIG, db);

    const result = await svc.isLocked('cred-1');

    expect(result.locked).toBe(false);
  });

  it('returns locked=false when credential not found', async () => {
    const db = makeDb({ findFirst: vi.fn(async () => null) });
    const svc = createCredentialService(TEST_CONFIG, db);

    const result = await svc.isLocked('no-such-id');

    expect(result.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Logging — password must never be logged
// ---------------------------------------------------------------------------

describe('CredentialService — password redaction', () => {
  it('never passes password to the logger during hashPassword', async () => {
    const loggedMessages: unknown[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => {
        loggedMessages.push(JSON.stringify(obj));
        loggedMessages.push(msg);
      },
    };
    const svc = createCredentialService(TEST_CONFIG, makeDb(), logger);
    const password = 'SuperSecret$Pass99';

    await svc.hashPassword(password);

    for (const entry of loggedMessages) {
      expect(String(entry)).not.toContain(password);
    }
  });

  it('never passes password to the logger during verifyPassword', async () => {
    const loggedMessages: unknown[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => {
        loggedMessages.push(JSON.stringify(obj));
        loggedMessages.push(msg);
      },
    };
    const svc = createCredentialService(TEST_CONFIG, makeDb(), logger);
    const password = 'SuperSecret$Pass99';
    const { hash } = await svc.hashPassword(password);

    await svc.verifyPassword(password, hash);
    await svc.verifyPassword(password, null);

    for (const entry of loggedMessages) {
      expect(String(entry)).not.toContain(password);
    }
  });
});
