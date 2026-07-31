/**
 * Unit tests for validateSecrets — startup secrets validator.
 *
 * Key invariants tested:
 *   - Present non-placeholder secrets → no exit, no log
 *   - Missing secrets → process.exit(1) with variable name in log
 *   - Placeholder-matching secrets → process.exit(1) with variable name in log
 *   - Secret VALUE is never logged (security constraint)
 *   - Multiple failures logged before exit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateSecrets, PLACEHOLDER_DENY_LIST } from '../validateSecrets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture log output from validateSecrets without allowing process.exit to run. */
function runValidator(
  envOverrides: Record<string, string | undefined>,
  specs: Array<{ envVar: string; description: string }>,
): { exitCalled: boolean; exitCode: number | undefined; loggedObjects: Record<string, unknown>[] } {
  const original: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    original[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  let exitCalled = false;
  let exitCode: number | undefined;
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((code?: number | string | null | undefined) => {
      exitCalled = true;
      exitCode = typeof code === 'number' ? code : Number(code ?? 0);
      throw new Error(`__process_exit_${exitCode}__`);
    });

  const loggedObjects: Record<string, unknown>[] = [];
  const mockLogger = {
    error: vi.fn((obj: Record<string, unknown>) => {
      loggedObjects.push({ ...obj });
    }),
  };

  try {
    validateSecrets(specs, mockLogger);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('__process_exit_')) {
      throw err;
    }
  } finally {
    exitSpy.mockRestore();
    // Restore original env vars
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  return { exitCalled, exitCode, loggedObjects };
}

// ---------------------------------------------------------------------------
// Clean env between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  delete process.env['__TEST_SECRET_A__'];
  delete process.env['__TEST_SECRET_B__'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Present and valid secrets
// ---------------------------------------------------------------------------

describe('valid secrets (present, not placeholder)', () => {
  it('does not call process.exit when all secrets are valid', () => {
    const { exitCalled } = runValidator(
      { '__TEST_SECRET_A__': 'a-very-long-random-secret-value-abc123' },
      [{ envVar: '__TEST_SECRET_A__', description: 'Test secret A' }],
    );
    expect(exitCalled).toBe(false);
  });

  it('accepts multiple valid secrets without exiting', () => {
    const { exitCalled } = runValidator(
      {
        '__TEST_SECRET_A__': 'correct-horse-battery-staple',
        '__TEST_SECRET_B__': 'sk_live_abc123xyz',
      },
      [
        { envVar: '__TEST_SECRET_A__', description: 'JWT secret' },
        { envVar: '__TEST_SECRET_B__', description: 'Stripe key' },
      ],
    );
    expect(exitCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing secret
// ---------------------------------------------------------------------------

describe('missing secret (env var not set)', () => {
  it('calls process.exit(1)', () => {
    const { exitCalled, exitCode } = runValidator(
      { '__TEST_SECRET_A__': undefined },
      [{ envVar: '__TEST_SECRET_A__', description: 'JWT secret' }],
    );
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('logs the variable name', () => {
    const { loggedObjects } = runValidator(
      { '__TEST_SECRET_A__': undefined },
      [{ envVar: '__TEST_SECRET_A__', description: 'JWT secret' }],
    );
    const logged = loggedObjects[0];
    expect(logged).toBeDefined();
    expect(logged?.['envVar']).toBe('__TEST_SECRET_A__');
  });

  it('does NOT log the secret value (security invariant)', () => {
    const { loggedObjects } = runValidator(
      { '__TEST_SECRET_A__': undefined },
      [{ envVar: '__TEST_SECRET_A__', description: 'JWT secret' }],
    );
    const logStr = JSON.stringify(loggedObjects);
    // undefined is not a secret value, but confirm the key 'value' is absent
    expect(logStr).not.toContain('"value"');
  });
});

// ---------------------------------------------------------------------------
// Placeholder-matching secrets
// ---------------------------------------------------------------------------

describe('placeholder secrets', () => {
  it.each(PLACEHOLDER_DENY_LIST.filter((p) => p.length > 0))(
    'rejects placeholder "%s"',
    (placeholder) => {
      const { exitCalled } = runValidator(
        { '__TEST_SECRET_A__': placeholder },
        [{ envVar: '__TEST_SECRET_A__', description: 'Test secret' }],
      );
      expect(exitCalled).toBe(true);
    },
  );

  it('rejects the dev-jwt-secret placeholder by name', () => {
    const { exitCalled, exitCode } = runValidator(
      { '__TEST_SECRET_A__': 'dev-jwt-secret' },
      [{ envVar: '__TEST_SECRET_A__', description: 'JWT secret' }],
    );
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('rejects empty string (empty Stripe webhook secret vulnerability)', () => {
    const { exitCalled, exitCode } = runValidator(
      { '__TEST_SECRET_A__': '' },
      [{ envVar: '__TEST_SECRET_A__', description: 'Stripe webhook secret' }],
    );
    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('rejects placeholder case-insensitively', () => {
    const { exitCalled } = runValidator(
      { '__TEST_SECRET_A__': 'CHANGE-ME' },
      [{ envVar: '__TEST_SECRET_A__', description: 'Test secret' }],
    );
    expect(exitCalled).toBe(true);
  });

  it('logs the variable NAME for a placeholder, not the placeholder VALUE', () => {
    const secretValue = 'dev-jwt-secret';
    const { loggedObjects } = runValidator(
      { '__TEST_SECRET_A__': secretValue },
      [{ envVar: '__TEST_SECRET_A__', description: 'JWT secret' }],
    );
    const logStr = JSON.stringify(loggedObjects);
    expect(loggedObjects[0]?.['envVar']).toBe('__TEST_SECRET_A__');
    expect(logStr).not.toContain(secretValue);
  });
});

// ---------------------------------------------------------------------------
// Multiple failures
// ---------------------------------------------------------------------------

describe('multiple failures', () => {
  it('logs all failing variables before exit', () => {
    const { loggedObjects, exitCalled } = runValidator(
      { '__TEST_SECRET_A__': undefined, '__TEST_SECRET_B__': 'change-me' },
      [
        { envVar: '__TEST_SECRET_A__', description: 'Secret A' },
        { envVar: '__TEST_SECRET_B__', description: 'Secret B' },
      ],
    );
    expect(exitCalled).toBe(true);
    const names = loggedObjects.map((o) => o['envVar']);
    expect(names).toContain('__TEST_SECRET_A__');
    expect(names).toContain('__TEST_SECRET_B__');
  });
});
