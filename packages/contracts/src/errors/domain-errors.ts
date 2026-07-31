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

/** 429 — account temporarily locked after too many failed authentication attempts. Does not disclose whether the account exists. */
export function accountTemporarilyLocked(retryAfterSeconds: number): DomainError {
  return new DomainErrorImpl(
    "ACCOUNT_TEMPORARILY_LOCKED",
    `Account temporarily locked. Please try again in ${retryAfterSeconds} seconds.`,
  );
}

/** 502 — the upstream supplier returned an error or unreachable response. */
export function supplierUnavailable(message = "Supplier is currently unavailable. Please try again."): DomainError {
  return new DomainErrorImpl("SUPPLIER_UNAVAILABLE", message);
}

/** 504 — the upstream supplier did not respond within the allowed timeout. */
export function supplierTimeout(message = "Supplier request timed out. Please try again."): DomainError {
  return new DomainErrorImpl("SUPPLIER_TIMEOUT", message);
}

/**
 * 502 — the outbound request was refused by the SSRF egress allow-list policy.
 * The attempted host is recorded in the security event, not in the response body.
 */
export function egressDenied(message = "Outbound request denied by security policy."): DomainError {
  return new DomainErrorImpl("EGRESS_DENIED", message);
}

/**
 * 422 — the selected offer is not bookable.
 *
 * Raised when an offer's provenance is ILLUSTRATIVE, the provenance string is
 * not in the approved supplier set, or the bookable flag is false.  The field
 * parameter names the offending field so the API response can attach it.
 */
export function offerNotBookable(
  message = "This offer cannot be booked.",
  field = "provenance",
): DomainError {
  return new DomainErrorImpl("OFFER_NOT_BOOKABLE", message, field);
}

/** 400 — password reset token is unknown, expired, or already consumed. */
export function invalidOrExpiredToken(
  message = "The reset token is invalid, expired, or has already been used.",
): DomainError {
  return new DomainErrorImpl("INVALID_OR_EXPIRED_TOKEN", message);
}

/** 422 — the supplied password is identical to the current stored password. */
export function passwordReuseNotAllowed(
  message = "New password must differ from the current password.",
): DomainError {
  return new DomainErrorImpl("PASSWORD_REUSE_NOT_ALLOWED", message, "password");
}

/** 401 — email or password did not match; collapses all credential failure reasons. */
export function invalidCredentials(
  message = "Invalid email or password.",
): DomainError {
  return new DomainErrorImpl("INVALID_CREDENTIALS", message);
}

/** 403 — the account exists but the email address has not been verified. */
export function emailNotVerified(
  message = "Please verify your email address before logging in.",
): DomainError {
  return new DomainErrorImpl("EMAIL_NOT_VERIFIED", message);
}

/** 403 — the account is suspended or deleted and may not authenticate. */
export function accountDisabled(
  message = "This account has been disabled. Please contact support.",
): DomainError {
  return new DomainErrorImpl("ACCOUNT_DISABLED", message);
}

/** 404 — the session id does not exist or does not belong to the caller. */
export function sessionNotFound(
  message = "Session not found.",
): DomainError {
  return new DomainErrorImpl("SESSION_NOT_FOUND", message);
}

/**
 * 410 — the offer existed but its expiresAt has passed.
 *
 * Raised on GET /v1/offers/{id} when the resolved offer's expiresAt is in the
 * past relative to the request clock. The booking flow must restart with a
 * fresh search. Never falls back to serving an expired offer.
 */
export function offerExpired(
  message = "This offer has expired. Please search again for current availability.",
  field?: string,
): DomainError {
  return new DomainErrorImpl("OFFER_EXPIRED", message, field);
}
