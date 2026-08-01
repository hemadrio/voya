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

/** 401 — the presented refresh token was already rotated or revoked (theft signal); the entire session family has been revoked. */
export function refreshTokenReused(
  message = "Refresh token has already been used. All sessions in this device family have been revoked.",
): DomainError {
  return new DomainErrorImpl("REFRESH_TOKEN_REUSED", message);
}

/** 401 — the session has exceeded its idle timeout or absolute lifetime. */
export function sessionExpired(
  message = "Your session has expired. Please log in again.",
): DomainError {
  return new DomainErrorImpl("SESSION_EXPIRED", message);
}

/** 401 — the refresh token is unknown, malformed, or does not match any session. */
export function invalidRefreshToken(
  message = "Invalid or unknown refresh token.",
): DomainError {
  return new DomainErrorImpl("INVALID_REFRESH_TOKEN", message);
}

/** 401 — JWT signature, expiry, issuer, audience, or claims are invalid. */
export function invalidToken(
  message = "The provided token is invalid or has expired.",
): DomainError {
  return new DomainErrorImpl("INVALID_TOKEN", message);
}

/** 401 — the session referenced by the token has been revoked or expired. */
export function sessionRevoked(
  message = "Your session has been revoked. Please log in again.",
): DomainError {
  return new DomainErrorImpl("SESSION_REVOKED", message);
}

/**
 * 403 — caller is authenticated but lacks the required roles or permissions.
 * @param required - the roles or permissions that were missing.
 */
export function insufficientPermissions(
  required: string[],
  message = "You do not have permission to perform this action.",
): DomainError & { required: string[] } {
  const err = new DomainErrorImpl("INSUFFICIENT_PERMISSIONS", message) as DomainError & { required: string[] };
  err.required = required;
  return err;
}

/**
 * 409 — the booking has not passed price re-validation, or a changed price
 * has not been explicitly accepted by the traveler.  No Stripe call is made.
 */
export function priceConsentRequired(
  message = "Price re-validation or explicit consent is required before payment can be initiated.",
): DomainError {
  return new DomainErrorImpl("PRICE_CONSENT_REQUIRED", message);
}

/**
 * 409 — the price quote the traveler is trying to accept has expired.
 * The booking must be re-validated to obtain a fresh quote.
 */
export function quoteExpired(
  message = "The price quote has expired. Please re-validate the booking price before accepting.",
): DomainError {
  return new DomainErrorImpl("QUOTE_EXPIRED", message);
}

/**
 * 409 — the booking is not in a state that allows payment initiation.
 * This is distinct from PRICE_CONSENT_REQUIRED: it means the booking itself
 * (status, expiry) prevents payment — not just the re-validation gate.
 */
export function bookingNotPayable(
  message = "This booking is not in a payable state. It may be expired, already confirmed, or cancelled.",
): DomainError {
  return new DomainErrorImpl("BOOKING_NOT_PAYABLE", message);
}

/**
 * 422 — the requested currency is not supported by the configured payment
 * provider account.  The caller should retry with a supported currency.
 */
export function unsupportedCurrency(
  currency: string,
  message = `Currency "${currency}" is not supported by the payment provider.`,
): DomainError {
  return new DomainErrorImpl("UNSUPPORTED_CURRENCY", message, "currency");
}

/**
 * 502 — the payment provider (Stripe) is unreachable or returned a 5xx.
 * The client should retry using the same request (the idempotency key
 * guarantees the provider will return the same intent on retry).
 */
export function providerUnavailable(
  message = "The payment provider is temporarily unavailable. Please retry the request.",
): DomainError {
  return new DomainErrorImpl("PROVIDER_UNAVAILABLE", message);
}

/**
 * 400 — the Stripe webhook stripe-signature header is absent, malformed, or
 * its HMAC does not match the raw payload (possible replay or forgery).
 *
 * The message must NOT contain the signing secret or the raw body.
 * The response to the client is always a generic "signature verification
 * failed" — no failure detail is echoed to prevent oracle attacks.
 */
export function signatureVerificationFailed(
  message = "Webhook signature verification failed.",
): DomainError {
  return new DomainErrorImpl("SIGNATURE_VERIFICATION_FAILED", message);
}

/**
 * 409 — the requested refund would cause cumulative refunds to exceed the
 * original charge amount.  All arithmetic is in integer minor units.
 *
 * @param alreadyRefundedMinor — total already refunded (minor units).
 * @param chargeMinor          — original charge amount (minor units).
 * @param requestedMinor       — amount the caller requested to refund.
 */
export function refundExceedsCharge(
  alreadyRefundedMinor: bigint,
  chargeMinor: bigint,
  requestedMinor: bigint,
  message?: string,
): DomainError & { alreadyRefundedMinor: bigint; remainingMinor: bigint; requestedMinor: bigint } {
  const remainingMinor = chargeMinor - alreadyRefundedMinor;
  const defaultMessage =
    `Refund of ${requestedMinor} would exceed the original charge of ${chargeMinor}. ` +
    `Already refunded: ${alreadyRefundedMinor}, remaining: ${remainingMinor}.`;
  const err = new DomainErrorImpl(
    "REFUND_EXCEEDS_CHARGE",
    message ?? defaultMessage,
  ) as DomainError & { alreadyRefundedMinor: bigint; remainingMinor: bigint; requestedMinor: bigint };
  err.alreadyRefundedMinor = alreadyRefundedMinor;
  err.remainingMinor = remainingMinor;
  err.requestedMinor = requestedMinor;
  return err;
}

/**
 * 422 — the booking leg is non-refundable per the supplier terms in the
 * offer snapshot.  The response names the leg and the supplier term that
 * applies so the caller can surface it to the traveler.
 *
 * @param legId       — the leg that is non-refundable (undefined for a full booking).
 * @param supplierTerm — the supplier term key that prevents the refund.
 */
export function notRefundable(
  legId: string | undefined,
  supplierTerm: string,
  message?: string,
): DomainError & { legId: string | undefined; supplierTerm: string } {
  const defaultMessage = legId
    ? `Leg "${legId}" is non-refundable per supplier term "${supplierTerm}".`
    : `This booking is non-refundable per supplier term "${supplierTerm}".`;
  const err = new DomainErrorImpl(
    "NOT_REFUNDABLE",
    message ?? defaultMessage,
  ) as DomainError & { legId: string | undefined; supplierTerm: string };
  err.legId = legId;
  err.supplierTerm = supplierTerm;
  return err;
}
