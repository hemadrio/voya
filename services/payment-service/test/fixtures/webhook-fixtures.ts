/**
 * Signed webhook payload fixtures for payment_intent.succeeded,
 * payment_intent.payment_failed and charge.refunded (WO-046, AC11).
 *
 * All event IDs and booking IDs are synthetic (SYNTH-* prefix).
 * NEVER use real or production-derived data.
 *
 * Usage:
 *   import { makeWebhookHeader, FIXTURE_PAYMENT_SUCCEEDED } from './webhook-fixtures.js';
 *   const sig = makeWebhookHeader(FIXTURE_PAYMENT_SUCCEEDED, TEST_SECRET, Date.now() / 1000);
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WEBHOOK_TEST_SECRET = "whsec_SYNTH0000000000000000000000001";
export const WEBHOOK_WRONG_SECRET = "whsec_SYNTH0000000000000000000000002";

/** Fixed timestamp for deterministic tests (2025-01-01T00:00:00Z) */
export const WEBHOOK_FIXED_TIMESTAMP = 1735689600;

export const SYNTH_BOOKING_ID = "f0000002-0000-4000-8000-000000000001";
export const SYNTH_PAYMENT_INTENT_ID = "pi_SYNTH0000000000001";

// ---------------------------------------------------------------------------
// Signature generation helper
// ---------------------------------------------------------------------------

/**
 * Generate a valid Stripe-Signature header value for the given body.
 *
 * Format: `t=<timestamp>,v1=<hmac_hex>`
 *
 * @param body             - Raw webhook body (string or Buffer)
 * @param secret           - Webhook signing secret
 * @param timestampSeconds - Unix timestamp (default: WEBHOOK_FIXED_TIMESTAMP)
 */
export function makeWebhookHeader(
  body: string | Buffer,
  secret: string,
  timestampSeconds: number = WEBHOOK_FIXED_TIMESTAMP,
): string {
  const bodyStr = typeof body === "string" ? body : body.toString("utf8");
  const signedPayload = `${timestampSeconds}.${bodyStr}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * Generate a valid Stripe-Signature header for the CURRENT time.
 * Use when the verifier is not configured with a fixed clock.
 */
export function makeWebhookHeaderNow(
  body: string | Buffer,
  secret: string,
): string {
  return makeWebhookHeader(body, secret, Math.floor(Date.now() / 1000));
}

// ---------------------------------------------------------------------------
// Fixture: payment_intent.succeeded
// ---------------------------------------------------------------------------

export const FIXTURE_PAYMENT_SUCCEEDED = JSON.stringify({
  id: "SYNTH-EVT-0001",
  object: "event",
  api_version: "2023-10-16",
  created: WEBHOOK_FIXED_TIMESTAMP,
  type: "payment_intent.succeeded",
  livemode: false,
  data: {
    object: {
      id: SYNTH_PAYMENT_INTENT_ID,
      object: "payment_intent",
      amount: 49999,
      currency: "usd",
      status: "succeeded",
      client_secret: null, // never present in webhook events
      metadata: {
        bookingId: SYNTH_BOOKING_ID,
        idempotencyKey: `idem-${SYNTH_BOOKING_ID}-flight`,
      },
    },
  },
});

/** Valid Stripe-Signature header for FIXTURE_PAYMENT_SUCCEEDED */
export const SIG_PAYMENT_SUCCEEDED = makeWebhookHeader(
  FIXTURE_PAYMENT_SUCCEEDED,
  WEBHOOK_TEST_SECRET,
  WEBHOOK_FIXED_TIMESTAMP,
);

// ---------------------------------------------------------------------------
// Fixture: payment_intent.payment_failed
// ---------------------------------------------------------------------------

export const FIXTURE_PAYMENT_FAILED = JSON.stringify({
  id: "SYNTH-EVT-0002",
  object: "event",
  api_version: "2023-10-16",
  created: WEBHOOK_FIXED_TIMESTAMP,
  type: "payment_intent.payment_failed",
  livemode: false,
  data: {
    object: {
      id: SYNTH_PAYMENT_INTENT_ID,
      object: "payment_intent",
      amount: 49999,
      currency: "usd",
      status: "requires_payment_method",
      last_payment_error: {
        code: "card_declined",
        decline_code: "insufficient_funds",
        message: "Your card has insufficient funds.",
        // Card details are NOT stored — only the decline code
      },
      metadata: {
        bookingId: SYNTH_BOOKING_ID,
        idempotencyKey: `idem-${SYNTH_BOOKING_ID}-flight`,
      },
    },
  },
});

/** Valid Stripe-Signature header for FIXTURE_PAYMENT_FAILED */
export const SIG_PAYMENT_FAILED = makeWebhookHeader(
  FIXTURE_PAYMENT_FAILED,
  WEBHOOK_TEST_SECRET,
  WEBHOOK_FIXED_TIMESTAMP,
);

// ---------------------------------------------------------------------------
// Fixture: charge.refunded
// ---------------------------------------------------------------------------

export const FIXTURE_CHARGE_REFUNDED = JSON.stringify({
  id: "SYNTH-EVT-0003",
  object: "event",
  api_version: "2023-10-16",
  created: WEBHOOK_FIXED_TIMESTAMP,
  type: "charge.refunded",
  livemode: false,
  data: {
    object: {
      id: "ch_SYNTH0000000000001",
      object: "charge",
      amount: 49999,
      amount_refunded: 49999,
      currency: "usd",
      payment_intent: SYNTH_PAYMENT_INTENT_ID,
      refunded: true,
      metadata: {
        bookingId: SYNTH_BOOKING_ID,
      },
    },
  },
});

/** Valid Stripe-Signature header for FIXTURE_CHARGE_REFUNDED */
export const SIG_CHARGE_REFUNDED = makeWebhookHeader(
  FIXTURE_CHARGE_REFUNDED,
  WEBHOOK_TEST_SECRET,
  WEBHOOK_FIXED_TIMESTAMP,
);

// ---------------------------------------------------------------------------
// Tampered variants (for negative tests)
// ---------------------------------------------------------------------------

/** FIXTURE_PAYMENT_SUCCEEDED with amount tampered — HMAC will be invalid */
export const FIXTURE_PAYMENT_SUCCEEDED_TAMPERED = FIXTURE_PAYMENT_SUCCEEDED.replace(
  '"amount": 49999',
  '"amount": 1',
);

/** Stale timestamp header — signed correctly but 2 hours in the past */
export const SIG_PAYMENT_SUCCEEDED_STALE = makeWebhookHeader(
  FIXTURE_PAYMENT_SUCCEEDED,
  WEBHOOK_TEST_SECRET,
  WEBHOOK_FIXED_TIMESTAMP - 7200,
);

/** Header signed with wrong secret */
export const SIG_PAYMENT_SUCCEEDED_WRONG_SECRET = makeWebhookHeader(
  FIXTURE_PAYMENT_SUCCEEDED,
  WEBHOOK_WRONG_SECRET,
  WEBHOOK_FIXED_TIMESTAMP,
);
