import { ZodError } from "zod";
import type { ErrorEnvelope } from "./envelope.js";
import { ErrorCode, ERROR_STATUS_MAP } from "./codes.js";
import type { DomainError } from "./domain-errors.js";

// Pre-computed array of valid ErrorCode values for the type-guard below.
const ALL_ERROR_CODE_VALUES: ReadonlyArray<string> = Object.values(ErrorCode);

/**
 * Restricted-tier field names — mirrors the Pino logger redaction paths so
 * that the two cannot drift.  The serialiser consults this list before
 * embedding any received value in a response message, ensuring that passport
 * numbers, dates of birth, email addresses, password hashes, and authentication
 * headers are never echoed back to the client through the error body.
 *
 * This list is the single source of truth for HTTP-response-level redaction;
 * update it whenever a new Restricted-tier field is added to the data model.
 */
export const RESTRICTED_FIELDS: ReadonlyArray<string> = [
  "passportNumber",
  "dateOfBirth",
  "email",
  "passwordHash",
  "authorization",
  "stripe-signature",
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generate a sortable correlation identifier without OpenTelemetry.
 * Format: `<base36-timestamp>-<random-hex-suffix>` — always non-empty and
 * monotonically sortable within a millisecond boundary.
 */
function generateCorrelationId(): string {
  const ts = Date.now().toString(36);
  // Build a pseudo-random suffix from multiple Math.random calls to reduce
  // collision probability inside the same millisecond.
  const rand =
    Math.random().toString(36).slice(2, 7) +
    Math.random().toString(36).slice(2, 7);
  return `${ts}-${rand}`;
}

/** Return the caller-supplied trace ID or a locally generated fallback. */
function resolveReference(traceId?: string): string {
  if (typeof traceId === "string" && traceId.trim().length > 0) {
    return traceId.trim();
  }
  return generateCorrelationId();
}

/**
 * Determine whether a Zod path segment is a Restricted-tier field name.
 * Matches the last string segment of the path (e.g. `passportNumber` in
 * `["passengers", 0, "passportNumber"]`).
 */
function lastSegmentIsRestricted(path: ReadonlyArray<string | number>): boolean {
  const last = path[path.length - 1];
  return typeof last === "string" && RESTRICTED_FIELDS.includes(last);
}

/**
 * Join a Zod issue path into a dotted string suitable for the `field` key.
 * Array indices become numeric segments: `passengers.0.passportNumber`.
 * Returns `undefined` for an empty path (whole-body or top-level refinement).
 */
function pathToField(path: ReadonlyArray<string | number>): string | undefined {
  if (path.length === 0) return undefined;
  return path.join(".");
}

/**
 * Produce a safe, non-leaking message for a Restricted-tier field failure.
 * The field name is always shown; the rejected value is never echoed.
 */
function safeMessageForRestrictedField(field: string): string {
  return `Invalid value for field: ${field}`;
}

/**
 * Type guard that checks whether `err` is a DomainError raised by one of the
 * factory helpers in `domain-errors.ts`.
 */
function isDomainError(err: unknown): err is DomainError {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    ALL_ERROR_CODE_VALUES.includes((err as { code: string }).code)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The value returned by `serialiseError`. */
export interface SerialiseResult {
  /** The envelope object ready for `res.json()`. */
  readonly envelope: ErrorEnvelope;
  /** The HTTP status code to use for `res.status()`. */
  readonly status: number;
}

/**
 * Convert an unknown thrown value into a typed error envelope plus HTTP status.
 *
 * Three dispatch paths:
 *
 * 1. **ZodError** — converts the first failing issue (in path order) into a
 *    `VALIDATION_FAILED` envelope.  Restricted-tier field values are never
 *    echoed; only the field name is included.
 *
 * 2. **DomainError** — uses the `code` and optional `field` from the typed
 *    error to produce the correct envelope and look up the HTTP status.
 *
 * 3. **Unknown / catch-all** — always yields `INTERNAL_ERROR` with a fixed
 *    generic message and status 500.  The original error message, stack
 *    trace, class name, SQL text, environment variable value, file path, or
 *    any other internal detail is discarded entirely (policy A10).
 *
 * @param err      The thrown value (any type, including non-Error primitives).
 * @param traceId  Active trace / correlation ID injected by the caller.
 *                 When absent, a sortable fallback identifier is generated
 *                 locally so the contracts package stays free of any
 *                 OpenTelemetry dependency.
 */
export function serialiseError(err: unknown, traceId?: string): SerialiseResult {
  const reference = resolveReference(traceId);

  // ------------------------------------------------------------------
  // Path 1: Zod validation error
  // ------------------------------------------------------------------
  if (err instanceof ZodError) {
    const issues = err.issues;
    const firstIssue = issues[0];

    let field: string | undefined;
    let message: string;

    if (firstIssue !== undefined) {
      field = pathToField(firstIssue.path);

      if (field !== undefined && lastSegmentIsRestricted(firstIssue.path)) {
        // Restricted field — emit name only, never the rejected value.
        message = safeMessageForRestrictedField(field);
      } else {
        message = firstIssue.message;
      }
    } else {
      message = "Validation failed";
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message,
        ...(field !== undefined ? { field } : {}),
      },
      reference,
    };

    return { envelope, status: 400 };
  }

  // ------------------------------------------------------------------
  // Path 2: Typed domain error from the factory helpers
  // ------------------------------------------------------------------
  if (isDomainError(err)) {
    const code = err.code;
    const status = ERROR_STATUS_MAP[code];

    const envelope: ErrorEnvelope = {
      error: {
        code,
        message: err.message,
        ...(err.field !== undefined ? { field: err.field } : {}),
      },
      reference,
    };

    return { envelope, status };
  }

  // ------------------------------------------------------------------
  // Path 3: Unknown / unrecognised throw (policy A10 — never leak)
  // ------------------------------------------------------------------
  const envelope: ErrorEnvelope = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message:
        "An unexpected error occurred. Please contact support with the reference identifier.",
    },
    reference,
  };

  return { envelope, status: 500 };
}
