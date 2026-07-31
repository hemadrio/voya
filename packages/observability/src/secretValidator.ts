/**
 * Fail-fast startup secret validator.
 *
 * Design goals:
 *   - Pure validate() function: takes a manifest and an env map, returns a
 *     typed result — no process control, fully unit-testable.
 *   - assertSecretsOrExit() wrapper: reads process.env, calls validate(), logs
 *     all violations (key names only — never values), and calls process.exit(1).
 *   - Relaxed dev mode: when NODE_ENV=development, violations are logged at
 *     warn level and execution continues instead of exiting. This relaxation
 *     is impossible in staging or production.
 *   - Placeholder blocklist: well-known development literals that must never
 *     reach production (empty string, change-me, dev-secret-change-me, etc.)
 *   - Minimum-length rule: signing keys shorter than minLength are rejected
 *     regardless of their value.
 *   - Secret values never appear in any log line or error message.
 */

// ---------------------------------------------------------------------------
// Violation codes (exported so callers can discriminate)
// ---------------------------------------------------------------------------

export type SecretViolationCode =
  | 'MISSING_SECRET'
  | 'PLACEHOLDER_SECRET_DETECTED'
  | 'SECRET_TOO_SHORT';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single secret requirement declared by a service.
 *
 * allowEmptyInDev — when true, this secret is exempt from the validator in
 * NODE_ENV=development so local dev without all third-party credentials works.
 * Never set this for first-party secrets (JWT keys, DB URLs, Stripe keys).
 */
export interface SecretDescriptor {
  readonly envVar: string;
  readonly description: string;
  /** Reject values shorter than this byte count (default: no minimum). */
  readonly minLength?: number | undefined;
  /** Allow placeholder / missing value only when NODE_ENV=development. */
  readonly allowEmptyInDev?: boolean | undefined;
}

export interface SecretViolation {
  readonly envVar: string;
  readonly description: string;
  readonly code: SecretViolationCode;
  readonly reason: string;
}

export interface SecretValidationResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<SecretViolation>;
}

// ---------------------------------------------------------------------------
// Placeholder blocklist
//
// Exact-match, case-insensitive, trim-normalised. The list is a named export
// so consuming code can reference it in documentation and tests without
// re-declaring the values.
// ---------------------------------------------------------------------------

export const PLACEHOLDER_BLOCKLIST: ReadonlyArray<string> = [
  '',
  'dev-secret-change-me',
  'change-me',
  'changeme',
  'placeholder',
  'placeholder-secret',
  'secret',
  'example',
  'test',
  'testing',
  'dummy',
  'fake',
  'replace-me',
  'your-secret-here',
  'todo',
  'fixme',
  'not-set',
  'none',
  'null',
  'undefined',
  'xxx',
  'yyy',
  'zzz',
  'development-secret',
  'dev-jwt-secret',
];

// ---------------------------------------------------------------------------
// Pure validation function (no side effects)
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** When true, placeholder / missing secrets become warnings instead of errors.
   *  Should only be enabled when NODE_ENV=development. */
  readonly relaxed?: boolean;
}

/**
 * Validate an array of secret descriptors against the supplied env map.
 *
 * @param manifest - Declarative list of secrets this service requires.
 * @param env - Environment variable map (pass process.env or a test fixture).
 * @param opts - Optional control flags (relaxed dev mode).
 * @returns A typed result with ok=true when all secrets pass, plus the full
 *          violation list so all failures are reported in one error rather than
 *          one-per-restart-loop.
 */
export function validate(
  manifest: ReadonlyArray<SecretDescriptor>,
  env: Readonly<Record<string, string | undefined>>,
  opts?: ValidateOptions,
): SecretValidationResult {
  const violations: SecretViolation[] = [];

  for (const descriptor of manifest) {
    const raw = env[descriptor.envVar];

    // ── Missing check ──────────────────────────────────────────────────────
    if (raw === undefined) {
      violations.push({
        envVar: descriptor.envVar,
        description: descriptor.description,
        code: 'MISSING_SECRET',
        reason: 'environment variable is not set',
      });
      continue;
    }

    // Whitespace-only or newline-injected values are treated as missing.
    const trimmed = raw.trim();
    if (trimmed === '') {
      violations.push({
        envVar: descriptor.envVar,
        description: descriptor.description,
        code: 'MISSING_SECRET',
        reason: 'environment variable is set but empty or whitespace-only',
      });
      continue;
    }

    // ── Placeholder check ──────────────────────────────────────────────────
    // Exact match against the blocklist (case-insensitive, trimmed).
    // Substring matching is intentionally NOT used — a Stripe test-mode key
    // such as sk_test_abc123 starts with "test" as a prefix, not an exact
    // match, so it correctly passes this check.
    const lowered = trimmed.toLowerCase();
    if (PLACEHOLDER_BLOCKLIST.some((p) => p === lowered)) {
      violations.push({
        envVar: descriptor.envVar,
        description: descriptor.description,
        code: 'PLACEHOLDER_SECRET_DETECTED',
        reason: 'value matches the placeholder blocklist',
      });
      continue;
    }

    // ── Minimum-length check ───────────────────────────────────────────────
    if (descriptor.minLength !== undefined && trimmed.length < descriptor.minLength) {
      violations.push({
        envVar: descriptor.envVar,
        description: descriptor.description,
        code: 'SECRET_TOO_SHORT',
        reason: `value is ${trimmed.length} bytes; minimum required is ${descriptor.minLength}`,
      });
    }
  }

  // In relaxed mode, remove violations for secrets that opt in to dev exemption.
  if (opts?.relaxed === true) {
    const strictViolations = violations.filter((v) => {
      const desc = manifest.find((d) => d.envVar === v.envVar);
      // allowEmptyInDev only covers MISSING and PLACEHOLDER violations; a
      // SECRET_TOO_SHORT on a first-party key is never relaxed.
      return !(desc?.allowEmptyInDev === true &&
        (v.code === 'MISSING_SECRET' || v.code === 'PLACEHOLDER_SECRET_DETECTED'));
    });
    return { ok: strictViolations.length === 0, violations: strictViolations };
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Structured logger interface (duck-typed against pino.Logger)
// ---------------------------------------------------------------------------

interface ValidatorLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  fatal(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// assertSecretsOrExit — side-effect wrapper for service bootstraps
// ---------------------------------------------------------------------------

/**
 * Validate required secrets from process.env and exit the process on failure.
 *
 * Behaviour by NODE_ENV:
 *   development — relaxed mode: violations are logged at warn level; execution
 *                 continues. This relaxation is logged at warn to make it visible.
 *   staging / production / anything else — strict mode: all violations are
 *                 logged at fatal level and process.exit(1) is called before
 *                 the HTTP listener binds.
 *
 * Security invariant: secret VALUES are never logged. Only the envVar name,
 * description, violation code, and reason (which is fixed-text, not the value).
 *
 * @param manifest - The service's required-secret list.
 * @param logger - Optional structured logger. Falls back to a console.error
 *                 shim so it works before a Pino logger is constructed.
 */
export function assertSecretsOrExit(
  manifest: ReadonlyArray<SecretDescriptor>,
  logger?: ValidatorLogger,
): void {
  const nodeEnv = process.env['NODE_ENV'] ?? '';
  const isRelaxed = nodeEnv === 'development';

  const result = validate(
    manifest,
    process.env as Record<string, string | undefined>,
    { relaxed: isRelaxed },
  );

  if (result.ok) return;

  // Build a minimal log shim if no logger was provided.
  const logFatal = logger !== undefined
    ? (obj: Record<string, unknown>, msg: string) => logger.fatal(obj, msg)
    : (obj: Record<string, unknown>, msg: string) => {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ level: 'fatal', ...obj, msg }));
      };

  const logWarn = logger !== undefined
    ? (obj: Record<string, unknown>, msg: string) => logger.warn(obj, msg)
    : (obj: Record<string, unknown>, msg: string) => {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ level: 'warn', ...obj, msg }));
      };

  if (isRelaxed) {
    // Relaxed mode — log each violation as a warning and continue.
    logWarn(
      { violationCount: result.violations.length, nodeEnv },
      '[secretValidator] Running in RELAXED mode (NODE_ENV=development). ' +
        'Secret violations are warnings only — never use this mode in production.',
    );
    for (const v of result.violations) {
      logWarn(
        // IMPORTANT: only log envVar, code, and reason — NEVER the value.
        { envVar: v.envVar, description: v.description, code: v.code, reason: v.reason },
        `[secretValidator] Secret violation (relaxed mode): ${v.envVar}`,
      );
    }
    return;
  }

  // Strict mode — log all violations at fatal level then exit.
  for (const v of result.violations) {
    logFatal(
      { envVar: v.envVar, description: v.description, code: v.code, reason: v.reason },
      `[secretValidator] Required secret is invalid: ${v.envVar}`,
    );
  }

  process.exit(1);
}
