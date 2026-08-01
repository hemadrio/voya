/**
 * PaymentStatusPort — injectable port for resolving the Stripe PaymentIntent
 * status of a booking without making a live Stripe API call.
 *
 * The implementation reads from the local `payments` table (populated by the
 * Stripe webhook processor). This avoids N Stripe API calls per sweep run and
 * keeps the sweep within the private VPC boundary.
 *
 * Non-terminal Stripe PaymentIntent statuses that must cause a skip:
 *   requires_payment_method  — customer has not yet entered card details
 *   requires_confirmation    — waiting for the client to confirm
 *   requires_action          — 3DS / redirect pending
 *   processing               — payment in flight
 *   requires_capture         — authorised, awaiting manual capture
 *
 * Terminal statuses where expiry is safe:
 *   succeeded                — payment went through (booking should have been
 *                               confirmed already; sweep would be a no-op here)
 *   canceled                 — Stripe-side cancellation; payment never landed
 *
 * null result (no payment row) means the checkout was never attempted and
 * expiry is always safe.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The set of Stripe PaymentIntent statuses that block expiry. */
export const NON_TERMINAL_INTENT_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
]);

export interface PaymentIntentStatus {
  /** The provider-assigned intent reference (Stripe PaymentIntent ID). */
  intentId: string;
  /** The raw Stripe PaymentIntent status string. */
  status: string;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

/**
 * PaymentStatusPort — resolves the most-recent PaymentIntent status for a
 * booking from the local payments ledger.
 *
 * Returns null when no payment row exists (booking was never charged).
 * The concrete implementation queries the `payments` table directly.
 */
export interface PaymentStatusPort {
  getIntentStatus(bookingId: string): Promise<PaymentIntentStatus | null>;
}

// ---------------------------------------------------------------------------
// Guard helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the given Stripe PaymentIntent status is non-terminal
 * and the booking must NOT be expired by the sweep.
 */
export function isNonTerminalIntentStatus(status: string): boolean {
  return NON_TERMINAL_INTENT_STATUSES.has(status);
}
