/**
 * Startup secrets validator.
 *
 * Call validateSecrets(specs) before binding the HTTP listener.  If any
 * required secret is absent or matches a known placeholder value, the process
 * exits with code 1 after logging the offending variable name (never its value).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretSpec {
  /** Environment variable name. */
  readonly envVar: string;
  /** Human-readable description shown in the exit-log. */
  readonly description: string;
}

interface ValidationLogger {
  error(obj: Record<string, unknown>, msg: string): void;
  fatal?(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Placeholder deny-list
//
// Values that must be rejected even when the variable is technically "set".
// None of these strings are secret values themselves; they are well-known
// development fallbacks that must never reach production.
// ---------------------------------------------------------------------------

export const PLACEHOLDER_DENY_LIST: ReadonlyArray<string> = [
  // JWT secrets — dev fallback values found in local configs
  'dev-jwt-secret',
  'change-me',
  'changeme',
  'secret',
  'development-secret',
  'your-secret-here',
  'replace-me',
  // Stripe — an empty webhook secret causes signature verification to succeed
  // unconditionally, which is a critical security vulnerability.
  '',
  // Generic placeholders
  'placeholder',
  'todo',
  'fixme',
  'not-set',
  'none',
  'null',
  'undefined',
  'xxx',
  'yyy',
  'zzz',
  // Commonly copy-pasted example values
  'example',
  'test',
  'testing',
  'dummy',
  'fake',
];

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate that every declared secret is present and not a placeholder.
 *
 * On success: returns void (caller proceeds).
 * On failure: logs the offending variable NAME only (never its value) and
 *             calls process.exit(1) so a misconfigured task never serves traffic.
 *
 * The logger parameter is optional — defaults to console.error so the function
 * is usable before a structured logger is constructed.
 */
export function validateSecrets(
  specs: ReadonlyArray<SecretSpec>,
  logger?: ValidationLogger,
): void {
  const failures: Array<{ envVar: string; description: string; reason: string }> = [];

  for (const spec of specs) {
    const raw = process.env[spec.envVar];

    if (raw === undefined) {
      failures.push({ envVar: spec.envVar, description: spec.description, reason: 'not set' });
      continue;
    }

    const lowered = raw.trim().toLowerCase();
    if (PLACEHOLDER_DENY_LIST.some((p) => p.toLowerCase() === lowered)) {
      failures.push({
        envVar: spec.envVar,
        description: spec.description,
        reason: 'matches placeholder deny-list',
      });
    }
  }

  if (failures.length === 0) return;

  for (const { envVar, description, reason } of failures) {
    const logFn =
      logger !== undefined
        ? (logger.fatal ?? logger.error).bind(logger)
        : (obj: Record<string, unknown>, msg: string) => {
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({ ...obj, msg }));
          };

    logFn(
      {
        envVar,
        description,
        reason,
        // Explicitly DO NOT log the value
      },
      `Required secret is invalid: ${envVar}`,
    );
  }

  process.exit(1);
}
