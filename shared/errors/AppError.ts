/**
 * Class-based AppError hierarchy for services.
 *
 * Each subclass carries a strongly typed `code` field that matches ErrorCode
 * from @travel/contracts, so the existing serialiseError() function handles
 * every subclass via its isDomainError path — no additional switch needed.
 *
 * Use these classes when you need instanceof checks, exhaustive switches, or
 * compiler-enforced exhaustiveness.  The factory functions in
 * @travel/contracts/errors are an alternative for simpler throw sites.
 *
 * All subclasses call Object.setPrototypeOf to preserve instanceof semantics
 * across TypeScript class transpilation (required for target < ES2022).
 */

import type { ErrorCode } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Abstract base
// ---------------------------------------------------------------------------

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  readonly field?: string | undefined;

  protected constructor(message: string, field?: string) {
    super(message);
    this.name = this.constructor.name;
    this.field = field;
    // Maintain correct instanceof chain in environments that transpile classes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Concrete subclasses — one per meaningful ErrorCode
// ---------------------------------------------------------------------------

/** 400 — body or query failed Zod or business-rule validation. */
export class ValidationError extends AppError {
  readonly code = "VALIDATION_FAILED" as const satisfies ErrorCode;
  constructor(message: string, field?: string) {
    super(message, field);
  }
}

/** 401 — request carries no valid credentials. */
export class UnauthenticatedError extends AppError {
  readonly code = "UNAUTHENTICATED" as const satisfies ErrorCode;
  constructor(message = "Authentication required") {
    super(message);
  }
}

/** 403 — caller is authenticated but does not own or may not access the resource. */
export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const satisfies ErrorCode;
  constructor(message = "Access denied") {
    super(message);
  }
}

/** 404 — the requested resource does not exist or is not visible to the caller. */
export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const satisfies ErrorCode;
  constructor(message = "Resource not found", field?: string) {
    super(message, field);
  }
}

/** 409 — a uniqueness constraint or lifecycle state conflict. */
export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const satisfies ErrorCode;
  constructor(message: string, field?: string) {
    super(message, field);
  }
}

/** 409 — a booking or payment state-machine transition is not permitted. */
export class LifecycleConflictError extends AppError {
  readonly code = "LIFECYCLE_CONFLICT" as const satisfies ErrorCode;
  constructor(message: string) {
    super(message);
  }
}

/**
 * 422 — the supplier accepted the request but rejected the business content
 * (e.g. seat no longer available, card declined by issuer).
 */
export class SupplierRejectedError extends AppError {
  readonly code = "SUPPLIER_REJECTED" as const satisfies ErrorCode;
  constructor(message: string) {
    super(message);
  }
}

/**
 * 502 — upstream supplier is unreachable (circuit open, DNS failure, TLS error).
 */
export class SupplierUnavailableError extends AppError {
  readonly code = "SUPPLIER_UNAVAILABLE" as const satisfies ErrorCode;
  constructor(message = "Supplier service is temporarily unavailable") {
    super(message);
  }
}

/**
 * 504 — upstream supplier returned a response but exceeded the timeout budget.
 */
export class SupplierTimeoutError extends AppError {
  readonly code = "SUPPLIER_TIMEOUT" as const satisfies ErrorCode;
  constructor(message = "Supplier request timed out") {
    super(message);
  }
}

/** 429 — the caller has exceeded a rate limit. */
export class RateLimitedError extends AppError {
  readonly code = "RATE_LIMITED" as const satisfies ErrorCode;
  constructor(message = "Rate limit exceeded") {
    super(message);
  }
}
