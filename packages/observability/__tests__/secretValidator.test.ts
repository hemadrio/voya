/**
 * Unit tests for secretValidator.ts.
 *
 * Covers:
 *   - Missing key → MISSING_SECRET
 *   - Whitespace-only value → MISSING_SECRET
 *   - Empty string → MISSING_SECRET
 *   - Placeholder match → PLACEHOLDER_SECRET_DETECTED (exact, not substring)
 *   - Stripe sk_test_ prefix MUST NOT trigger PLACEHOLDER (exact-match only)
 *   - Valid key → ok: true
 *   - minLength violation → SECRET_TOO_SHORT
 *   - Multiple violations reported in a single result
 *   - Relaxed dev mode (allowEmptyInDev) lifts MISSING/PLACEHOLDER
 *   - Relaxed mode still enforces minLength
 *   - assertSecretsOrExit logs envVar name only — NEVER the value
 *   - assertSecretsOrExit exits in strict mode
 *   - assertSecretsOrExit warns and continues in relaxed dev mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import {
  validate,
  assertSecretsOrExit,
  PLACEHOLDER_BLOCKLIST,
} from '../src/secretValidator';
import type { SecretDescriptor } from '../src/secretValidator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JWT_KEY: SecretDescriptor = {
  envVar: 'JWT_SECRET',
  description: 'HS256 signing key',
  minLength: 32,
};

const DB_URL: SecretDescriptor = {
  envVar: 'DATABASE_URL',
  description: 'PostgreSQL connection string',
  minLength: 20,
};

const AMADEUS_KEY: SecretDescriptor = {
  envVar: 'AMADEUS_CLIENT_SECRET',
  description: 'Amadeus API secret (optional in dev)',
  allowEmptyInDev: true,
};

const MANIFEST: ReadonlyArray<SecretDescriptor> = [JWT_KEY, DB_URL];

// ---------------------------------------------------------------------------
// validate() — missing / empty
// ---------------------------------------------------------------------------

describe('validate — missing and empty', () => {
  it('returns MISSING_SECRET when env var is undefined', () => {
    const result = validate([JWT_KEY], {});
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.code).toBe('MISSING_SECRET');
    expect(result.violations[0]!.envVar).toBe('JWT_SECRET');
  });

  it('returns MISSING_SECRET for empty string value', () => {
    const result = validate([JWT_KEY], { JWT_SECRET: '' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.code).toBe('MISSING_SECRET');
  });

  it('returns MISSING_SECRET for whitespace-only value', () => {
    const result = validate([JWT_KEY], { JWT_SECRET: '   \t\n  ' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.code).toBe('MISSING_SECRET');
  });
});

// ---------------------------------------------------------------------------
// validate() — placeholder detection
// ---------------------------------------------------------------------------

describe('validate — placeholder blocklist (exact match)', () => {
  it('flags "changeme" as PLACEHOLDER_SECRET_DETECTED', () => {
    const result = validate([JWT_KEY], { JWT_SECRET: 'changeme' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.code).toBe('PLACEHOLDER_SECRET_DETECTED');
  });

  it('flags "placeholder" regardless of case', () => {
    const result = validate([JWT_KEY], { JWT_SECRET: 'PLACEHOLDER' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.code).toBe('PLACEHOLDER_SECRET_DETECTED');
  });

  it('flags "test" as a placeholder', () => {
    const result = validate([JWT_KEY], { JWT_SECRET: 'test' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.code).toBe('PLACEHOLDER_SECRET_DETECTED');
  });

  it('does NOT flag a Stripe sk_test_ prefixed key (exact-match only)', () => {
    const stripeDescriptor: SecretDescriptor = {
      envVar: 'STRIPE_SECRET_KEY',
      description: 'Stripe secret key',
      minLength: 20,
    };
    // sk_test_abc123XYZ_more_data is NOT in the blocklist — it starts with
    // "sk_test_" but that is not the same as the exact blocklist entry "test".
    const result = validate([stripeDescriptor], {
      STRIPE_SECRET_KEY: 'sk_test_abc123XYZ_more_data_pad',
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('blocklist values themselves are all lower-case (invariant check)', () => {
    for (const entry of PLACEHOLDER_BLOCKLIST) {
      expect(entry).toBe(entry.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// validate() — valid secrets
// ---------------------------------------------------------------------------

describe('validate — valid secrets', () => {
  it('returns ok:true when all secrets are present and not placeholders', () => {
    const result = validate(MANIFEST, {
      JWT_SECRET: 'a-real-32-byte-signing-key-value!',
      DATABASE_URL: 'postgresql://user:pass@host:5432/db',
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validate() — minLength
// ---------------------------------------------------------------------------

describe('validate — minLength', () => {
  it('flags a secret shorter than minLength as SECRET_TOO_SHORT', () => {
    const result = validate([JWT_KEY], { JWT_SECRET: 'tooshort' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.code).toBe('SECRET_TOO_SHORT');
  });

  it('accepts a secret exactly at minLength', () => {
    const exactly32 = 'x'.repeat(32);
    const result = validate([JWT_KEY], { JWT_SECRET: exactly32 });
    expect(result.ok).toBe(true);
  });

  it('accepts a secret longer than minLength', () => {
    const long = 'a'.repeat(64);
    const result = validate([JWT_KEY], { JWT_SECRET: long });
    expect(result.ok).toBe(true);
  });

  it('does not apply minLength when the key is missing (MISSING takes precedence)', () => {
    const result = validate([JWT_KEY], {});
    expect(result.violations[0]!.code).toBe('MISSING_SECRET');
  });
});

// ---------------------------------------------------------------------------
// validate() — multiple violations
// ---------------------------------------------------------------------------

describe('validate — multiple violations reported at once', () => {
  it('reports all failures in one result rather than stopping at the first', () => {
    const result = validate(MANIFEST, {
      JWT_SECRET: undefined,
      DATABASE_URL: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    const codes = result.violations.map((v) => v.code);
    expect(codes).toEqual(['MISSING_SECRET', 'MISSING_SECRET']);
  });

  it('reports mixed violation types together', () => {
    const result = validate(MANIFEST, {
      JWT_SECRET: 'placeholder',
      DATABASE_URL: 'short',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]!.code).toBe('PLACEHOLDER_SECRET_DETECTED');
    expect(result.violations[1]!.code).toBe('SECRET_TOO_SHORT');
  });
});

// ---------------------------------------------------------------------------
// validate() — relaxed dev mode
// ---------------------------------------------------------------------------

describe('validate — relaxed dev mode', () => {
  it('removes violations for allowEmptyInDev secrets when relaxed:true', () => {
    const result = validate([AMADEUS_KEY], {}, { relaxed: true });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('still reports violations for non-exempt secrets in relaxed mode', () => {
    const result = validate(
      [JWT_KEY, AMADEUS_KEY],
      { AMADEUS_CLIENT_SECRET: undefined },
      { relaxed: true },
    );
    // JWT_KEY has no allowEmptyInDev; AMADEUS_KEY does.
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.envVar === 'JWT_SECRET')).toBe(true);
    expect(result.violations.some((v) => v.envVar === 'AMADEUS_CLIENT_SECRET')).toBe(false);
  });

  it('does NOT exempt minLength violations even for allowEmptyInDev secrets', () => {
    const exemptWithMinLen: SecretDescriptor = {
      envVar: 'SOME_KEY',
      description: 'A key with both flags',
      minLength: 32,
      allowEmptyInDev: true,
    };
    const result = validate(
      [exemptWithMinLen],
      { SOME_KEY: 'too-short' },
      { relaxed: true },
    );
    // Value is present and not a placeholder, but fails minLength.
    // allowEmptyInDev only covers MISSING and PLACEHOLDER — not too-short.
    expect(result.violations[0]!.code).toBe('SECRET_TOO_SHORT');
  });
});

// ---------------------------------------------------------------------------
// assertSecretsOrExit — log-value-redaction invariant
// ---------------------------------------------------------------------------

describe('assertSecretsOrExit — values must never appear in logs', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env entries we mutated.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('logs the envVar name but never the secret value on violation (relaxed mode)', () => {
    const SECRET_VALUE = 'super-secret-value-that-must-not-appear-in-any-log';
    process.env['NODE_ENV'] = 'development';
    process.env['JWT_SECRET'] = SECRET_VALUE;

    const warnMock = vi.fn();
    const mockLogger = { warn: warnMock, error: vi.fn(), fatal: vi.fn() };

    assertSecretsOrExit(
      [{ envVar: 'JWT_SECRET', description: 'signing key', minLength: 200 }],
      mockLogger,
    );

    // Every log call must NOT contain the secret value.
    for (const call of warnMock.mock.calls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain(SECRET_VALUE);
    }
    // The envVar NAME must appear.
    const allArgs = JSON.stringify(warnMock.mock.calls);
    expect(allArgs).toContain('JWT_SECRET');
  });
});

// ---------------------------------------------------------------------------
// assertSecretsOrExit — process.exit behaviour
// ---------------------------------------------------------------------------

describe('assertSecretsOrExit — exit behaviour', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: MockInstance;

  beforeEach(() => {
    originalEnv = { ...process.env };
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // suppress; just record the call
    }) as (code?: number) => never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('calls process.exit(1) in strict mode when secrets are invalid', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['JWT_SECRET'];

    const mockLogger = { warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
    assertSecretsOrExit([JWT_KEY], mockLogger);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT call process.exit in development relaxed mode with allowEmptyInDev', () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['AMADEUS_CLIENT_SECRET'];

    const mockLogger = { warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
    assertSecretsOrExit([AMADEUS_KEY], mockLogger);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs at warn level (not fatal) in relaxed mode', () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['AMADEUS_CLIENT_SECRET'];

    const warnMock = vi.fn();
    const fatalMock = vi.fn();
    const mockLogger = { warn: warnMock, error: vi.fn(), fatal: fatalMock };

    assertSecretsOrExit([AMADEUS_KEY], mockLogger);

    expect(warnMock).toHaveBeenCalled();
    expect(fatalMock).not.toHaveBeenCalled();
  });

  it('returns early (no exit, no log) when all secrets are valid', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['JWT_SECRET'] = 'a-real-32-byte-signing-key-value!';

    const mockLogger = { warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
    assertSecretsOrExit([JWT_KEY], mockLogger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockLogger.fatal).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
