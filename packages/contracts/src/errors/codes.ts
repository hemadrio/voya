/**
 * ErrorCode union and exhaustive HTTP status mapping table.
 *
 * The mapping is typed as `Record<ErrorCode, number>` so that a missing
 * entry is a TypeScript compile error, not a runtime surprise.  Every new
 * code that is added to `ErrorCode` MUST be given a corresponding entry here
 * or the package will fail to build.
 *
 * Allowed HTTP statuses and their semantics:
 *   400 — malformed or failed validation
 *   401 — unauthenticated
 *   403 — authenticated but forbidden
 *   404 — resource not found
 *   409 — lifecycle or uniqueness conflict
 *   422 — supplier rejection
 *   429 — rate limited
 *   500 — unexpected internal error (INTERNAL_ERROR only)
 *   502 — supplier failure / upstream unavailable
 *   504 — supplier timeout
 */

// ---------------------------------------------------------------------------
// ErrorCode union
// ---------------------------------------------------------------------------

/**
 * Every error the platform can surface to a client.  Values are plain
 * strings so they are serialisable without loss and can appear verbatim in
 * API responses.
 */
export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  LIFECYCLE_CONFLICT: "LIFECYCLE_CONFLICT",
  DUPLICATE_EMAIL: "DUPLICATE_EMAIL",
  SUPPLIER_REJECTED: "SUPPLIER_REJECTED",
  RATE_LIMITED: "RATE_LIMITED",
  SUPPLIER_UNAVAILABLE: "SUPPLIER_UNAVAILABLE",
  SUPPLIER_TIMEOUT: "SUPPLIER_TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  /** 502 — outbound request denied by the SSRF egress allow-list policy. */
  EGRESS_DENIED: "EGRESS_DENIED",
  /** 422 — the selected offer is not bookable (ILLUSTRATIVE, expired, or
   *  from an unrecognised provenance channel). */
  OFFER_NOT_BOOKABLE: "OFFER_NOT_BOOKABLE",
  /** 401 — a valid token that was explicitly revoked (logout, reuse detection). */
  TOKEN_REVOKED: "TOKEN_REVOKED",
  /** 403 — state-changing request lacks a valid CSRF double-submit token. */
  CSRF_FAILED: "CSRF_FAILED",
  /** 400 — password reset token is unknown, expired, or already consumed. */
  INVALID_OR_EXPIRED_TOKEN: "INVALID_OR_EXPIRED_TOKEN",
  /** 422 — the supplied password matches the current stored hash. */
  PASSWORD_REUSE_NOT_ALLOWED: "PASSWORD_REUSE_NOT_ALLOWED",
  /** 404 — the session id does not exist or does not belong to the caller. */
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// Exhaustive code-to-status table
// ---------------------------------------------------------------------------

/**
 * Single authoritative table binding each ErrorCode to one HTTP status.
 *
 * Typed as `Record<ErrorCode, number>` — a compile error is raised if any
 * ErrorCode member is absent.  A runtime test in
 * `test/errors/codes.test.ts` additionally iterates all values and asserts
 * they fall inside the set of allowed statuses.
 */
export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIFECYCLE_CONFLICT: 409,
  DUPLICATE_EMAIL: 409,
  SUPPLIER_REJECTED: 422,
  RATE_LIMITED: 429,
  SUPPLIER_UNAVAILABLE: 502,
  SUPPLIER_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
  EGRESS_DENIED: 502,
  OFFER_NOT_BOOKABLE: 422,
  TOKEN_REVOKED: 401,
  CSRF_FAILED: 403,
  INVALID_OR_EXPIRED_TOKEN: 400,
  PASSWORD_REUSE_NOT_ALLOWED: 422,
  SESSION_NOT_FOUND: 404,
};

/** Allowed HTTP statuses per the API contracts. */
export const ALLOWED_HTTP_STATUSES = new Set([
  400, 401, 403, 404, 409, 422, 429, 500, 502, 504,
]);

/**
 * Look up the HTTP status for a given ErrorCode.  Because the table is
 * exhaustive, this function always returns a value — `undefined` is
 * impossible at the type level.
 */
export function httpStatusForCode(code: ErrorCode): number {
  return ERROR_STATUS_MAP[code];
}
