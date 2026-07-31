/**
 * Startup environment validator.
 *
 * Wraps parseEnv() with process control: on parse failure it logs every
 * offending variable name and reason (never the value), then calls
 * process.exit(1) so the service never binds a port with bad configuration.
 *
 * Placeholder detection (via PLACEHOLDER_BLOCKLIST from @travel/observability)
 * runs as a second pass after schema validation so both type errors and
 * placeholder-value warnings are reported in one pass.
 *
 * Behaviour by NODE_ENV:
 *   development — schema errors are FATAL; placeholder matches emit a
 *                 structured warn and execution continues.
 *   staging / production / anything else — all violations are fatal.
 *
 * Security invariant: secret VALUES are NEVER logged — only variable names
 * and fixed-text reasons.
 */

import { z } from "zod";
import { PLACEHOLDER_BLOCKLIST } from "@travel/observability";
import { parseEnv, type ParseEnvResult } from "./env.js";

// ---------------------------------------------------------------------------
// Structured logger interface (duck-typed — no pino import needed)
// ---------------------------------------------------------------------------

interface StartupLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  fatal(obj: Record<string, unknown>, msg: string): void;
}

const defaultLogger: StartupLogger = {
  warn: (obj, msg) => {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ level: "warn", ...obj, msg }));
  },
  error: (obj, msg) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: "error", ...obj, msg }));
  },
  fatal: (obj, msg) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: "fatal", ...obj, msg }));
  },
};

// ---------------------------------------------------------------------------
// Placeholder scan — second pass after schema validation
// ---------------------------------------------------------------------------

/**
 * Check each string value in the parsed config against the placeholder
 * blocklist. Returns the list of variable names that matched.
 */
function scanForPlaceholders(
  env: Readonly<Record<string, string | undefined>>,
  schemaKeys: string[],
): string[] {
  const hits: string[] = [];
  for (const key of schemaKeys) {
    const raw = env[key];
    if (raw === undefined) continue;
    const lowered = raw.trim().toLowerCase();
    if (PLACEHOLDER_BLOCKLIST.some((p: string) => p === lowered)) {
      hits.push(key);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// validateStartupEnv — primary export
// ---------------------------------------------------------------------------

export interface ValidateStartupOptions {
  /** Override the logger (useful for tests that inject a silent logger). */
  readonly logger?: StartupLogger | undefined;
  /**
   * Override NODE_ENV detection. Pass 'development' in tests to exercise
   * relaxed-mode behaviour without mutating process.env.
   */
  readonly nodeEnv?: string | undefined;
  /**
   * Override process.exit. Pass a throwing function in tests to prevent the
   * real process from exiting (the function should throw to unwind the stack).
   */
  readonly exit?: ((code: number) => void) | undefined;
}

/**
 * Validate the process environment against a Zod schema at service startup.
 *
 * Call this before any server.listen() call. It never returns on failure in
 * non-development environments.
 *
 * @param schema - The Zod schema for this service (e.g. authServiceEnvSchema).
 * @param env - The environment record to validate (pass process.env or a fixture).
 * @param opts - Optional overrides for logger, NODE_ENV, and process.exit.
 * @returns The validated, frozen config object (T).
 */
export function validateStartupEnv<T>(
  schema: z.ZodType<T>,
  env: Readonly<Record<string, string | undefined>>,
  opts: ValidateStartupOptions = {},
): T {
  const logger = opts.logger ?? defaultLogger;
  const nodeEnv = opts.nodeEnv ?? env["NODE_ENV"] ?? "production";
  const isDevelopment = nodeEnv === "development";
  const doExit = opts.exit ?? ((code: number): void => { process.exit(code); });

  // ── Schema validation ────────────────────────────────────────────────────
  const parseResult: ParseEnvResult<T> = parseEnv(schema, env);

  if (!parseResult.ok) {
    for (const err of parseResult.errors) {
      logger.fatal(
        { variable: err.path, reason: err.message },
        `[env] Required environment variable is invalid: ${err.path}`,
      );
    }
    // Schema failures are always fatal — misconfigured types cannot be relaxed.
    doExit(1);
    return undefined as unknown as T;
  }

  // ── Placeholder scan ─────────────────────────────────────────────────────
  const schemaShape = (schema as { shape?: Record<string, unknown> }).shape;
  const schemaKeys = schemaShape ? Object.keys(schemaShape) : [];
  const placeholderHits = scanForPlaceholders(env, schemaKeys);

  if (placeholderHits.length > 0) {
    if (isDevelopment) {
      // Relaxed mode — warn and continue.
      logger.warn(
        {
          placeholderVariables: placeholderHits,
          nodeEnv,
          note: "Running in development mode. Placeholder values are permitted but you must replace them before deploying.",
        },
        `[env] ${placeholderHits.length} variable(s) contain placeholder values (development mode — continuing)`,
      );
      for (const varName of placeholderHits) {
        logger.warn(
          { variable: varName, reason: "value matches placeholder blocklist" },
          `[env] Placeholder value detected: ${varName}`,
        );
      }
    } else {
      // Strict mode — all placeholder hits are fatal.
      for (const varName of placeholderHits) {
        logger.fatal(
          {
            variable: varName,
            reason: "value matches placeholder blocklist",
            nodeEnv,
            hint: `Set NODE_ENV=development to downgrade this to a warning.`,
          },
          `[env] Placeholder value detected in non-development environment: ${varName}`,
        );
      }
      doExit(1);
      return undefined as unknown as T;
    }
  }

  return parseResult.config;
}
