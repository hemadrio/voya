import type { ErrorCode } from "./codes.js";

/**
 * Typed domain error interface.
 *
 * Services raise a `DomainError` (via the factory helpers below) instead of
 * constructing HTTP responses inline.  The shared serialiser reads `code` and
 * optional `field` to produce the correct envelope and status without any
 * service needing to know HTTP semantics.
 */
export interface DomainError extends Error {
  /** Platform error code — determines the HTTP status via the mapping table. */
  readonly code: ErrorCode;
  /** Dotted path to the offending input field, when applicable. */
  readonly field?: string | undefined;
}

// ---------------------------------------------------------------------------
// Internal concrete class — not exported; callers use the factories below.
// ---------------------------------------------------------------------------

class DomainErrorImpl extends Error implements DomainError {
  readonly code: ErrorCode;
  readonly field: string | undefined;

  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.field = field;
    // Maintain correct prototype chain in environments that transpile classes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Exported factory helpers
// ---------------------------------------------------------------------------

/** 400 — input failed schema or business-rule validation. */
export function validationFailed(message: string, field?: string): DomainError {
  return new DomainErrorImpl("VALIDATION_FAILED", message, field);
}

/** 401 — request carries no credentials or the credentials are expired/invalid. */
export function unauthenticated(message = "Authentication required"): DomainError {
  return new DomainErrorImpl("UNAUTHENTICATED", message);
}

/** 403 — caller is authenticated but does not own or may not access the resource. */
export function forbidden(message = "Access denied"): DomainError {
  return new DomainErrorImpl("FORBIDDEN", message);
}

/** 404 — the requested resource does not exist. */
export function notFound(message = "Resource not found", field?: string): DomainError {
  return new DomainErrorImpl("NOT_FOUND", message, field);
}

/** 409 — a general uniqueness or state conflict. */
export function conflict(message: string, field?: string): DomainError {
  return new DomainErrorImpl("CONFLICT", message, field);
}

/**
 * 409 — booking lifecycle violation; the message should name the current
 * state and the permitted transitions so the caller can act on it.
 */
export function lifecycleConflict(message: string): DomainError {
  return new DomainErrorImpl("LIFECYCLE_CONFLICT", message);
}

/** 409 — an account with the supplied email already exists. */
export function duplicateEmail(message = "An account with this email already exists"): DomainError {
  return new DomainErrorImpl("DUPLICATE_EMAIL", message, "email");
}

/**
 * 422 — the upstream supplier received and understood the request but
 * rejected it (e.g. offer expired, cabin class unavailable).
 */
export function supplierRejected(message: string): DomainError {
  return new DomainErrorImpl("SUPPLIER_REJECTED", message);
}

/** 429 — the caller has exceeded the allowed request rate. */
export function rateLimited(message = "Too many requests. Please try again later."): DomainError {
  return new DomainErrorImpl("RATE_LIMITED", message);
}

/** 502 — the upstream supplier returned an error or unreachable response. */
export function supplierUnavailable(message = "Supplier is currently unavailable. Please try again."): DomainError {
  return new DomainErrorImpl("SUPPLIER_UNAVAILABLE", message);
}

/** 504 — the upstream supplier did not respond within the allowed timeout. */
export function supplierTimeout(message = "Supplier request timed out. Please try again."): DomainError {
  return new DomainErrorImpl("SUPPLIER_TIMEOUT", message);
}
