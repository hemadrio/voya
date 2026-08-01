/**
 * StripePort — payment provider adapter interface (WO-045).
 *
 * The concrete implementation wraps the Stripe Node.js SDK and always passes
 * a deterministic idempotency key on create and cancel operations.
 *
 * The port is defined as an interface so:
 *   - Unit tests can supply an in-memory fake without the SDK.
 *   - Integration tests can target a stripe-mock local server.
 *   - The domain layer stays free of any provider SDK imports.
 *
 * PCI note: this interface deliberately omits any method that accepts
 * full card numbers, CVCs, or expiry dates.  Card capture happens in
 * Stripe-hosted fields in the browser — it never crosses the platform.
 */

// ---------------------------------------------------------------------------
// Stripe PaymentIntent status strings
// Mirrored from the Stripe SDK types to avoid a hard runtime dependency.
// ---------------------------------------------------------------------------

export type StripeIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

// ---------------------------------------------------------------------------
// Stripe adapter result types
// ---------------------------------------------------------------------------

/** Minimum subset of a Stripe PaymentIntent returned by the port. */
export interface StripeIntentResult {
  /** Stripe PaymentIntent ID (e.g. "pi_3..."). */
  id: string;
  /** Client secret for Stripe.js hosted fields. */
  clientSecret: string;
  /** Current PaymentIntent status. */
  status: StripeIntentStatus;
  /** Amount in the currency's minor unit (cents for USD/EUR). */
  amountMinor: bigint;
  /** ISO 4217 three-letter currency code, lower-case as Stripe returns it. */
  currency: string;
}

/** Parameters for creating a new PaymentIntent. */
export interface StripeCreateIntentParams {
  /** Amount in the currency's minor unit (must be a safe integer). */
  amountMinor: bigint;
  /** ISO 4217 three-letter currency code (lower-case). */
  currency: string;
  /** Internal booking ID used to populate the PaymentIntent metadata. */
  bookingId: string;
  /** Deterministic key derived from booking + amount + currency. */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// StripePort interface
// ---------------------------------------------------------------------------

/**
 * Port for Stripe PaymentIntent operations.
 *
 * Every mutating call carries an idempotency key so retries are safe.
 * The concrete implementation (StripeAdapter) handles SDK errors:
 *   - card_error / invalid_request_error → classified domain errors
 *   - rate limiting / 5xx → PROVIDER_UNAVAILABLE (502)
 */
export interface StripePort {
  /**
   * Create a new PaymentIntent.
   *
   * If Stripe already has an intent for this idempotency key it returns the
   * existing one (no second charge).
   *
   * @throws {DomainError} PROVIDER_UNAVAILABLE (502) on Stripe SDK errors.
   * @throws {DomainError} UNSUPPORTED_CURRENCY (422) when the currency is
   *   not supported by the configured Stripe account.
   */
  createIntent(params: StripeCreateIntentParams): Promise<StripeIntentResult>;
}

// ---------------------------------------------------------------------------
// Idempotency key derivation — deterministic, booking-scoped
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * Derive a deterministic Stripe idempotency key from the booking identifier,
 * accepted amount in minor units, and currency.
 *
 * Format: SHA-256(bookingId + ':' + amountMinor.toString() + ':' + currency)
 * Output: 64-character lowercase hex string (well within Stripe's 255-char limit).
 *
 * The key changes when the accepted total changes after re-validation, which
 * signals that the previous intent should be cancelled before creating a new one.
 */
export function deriveIdempotencyKey(
  bookingId: string,
  amountMinor: bigint,
  currency: string,
): string {
  return createHash("sha256")
    .update(`${bookingId}:${amountMinor.toString()}:${currency.toUpperCase()}`)
    .digest("hex");
}
