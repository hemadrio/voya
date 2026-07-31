/**
 * Stripe webhook event fixtures with synthetic signing helpers.
 *
 * These fixtures are used to exercise the WebhookVerifier without a real Stripe
 * account or signing secret. All secrets and event IDs are obviously synthetic
 * (per BR-18: no real credentials or real booking data in test fixtures).
 *
 * Usage in tests:
 *   const header = makeStripeSignatureHeader(SYNTHETIC_WEBHOOK_BODY, TEST_WEBHOOK_SECRET, nowSeconds);
 *   verifier.verify(SYNTHETIC_WEBHOOK_BODY, header);
 */

import { createHmac } from "node:crypto";
import { SEED_IDS, SEED_REFERENCE_INSTANT } from "../identifiers.js";

// ---------------------------------------------------------------------------
// Test signing secret — synthetic, never a real Stripe key
// ---------------------------------------------------------------------------

/**
 * Signing secret used across webhook-related tests.
 * Obviously synthetic: starts with "whsec_SYNTH" prefix.
 */
export const TEST_WEBHOOK_SECRET = "whsec_SYNTH0000000000000000000000001";

/**
 * A second synthetic signing secret — used for wrong-secret tests.
 */
export const TEST_WEBHOOK_SECRET_WRONG = "whsec_SYNTH0000000000000000000000002";

// ---------------------------------------------------------------------------
// Reference timestamp for deterministic tests
// ---------------------------------------------------------------------------

/** Stripe event timestamp (Unix seconds) matching SEED_REFERENCE_INSTANT. */
export const SEED_STRIPE_TIMESTAMP = Math.floor(SEED_REFERENCE_INSTANT.getTime() / 1000);

// ---------------------------------------------------------------------------
// Synthetic webhook bodies
// ---------------------------------------------------------------------------

/** payment_intent.succeeded event body. */
export const SYNTHETIC_WEBHOOK_BODY = JSON.stringify({
  id: "SYNTH-EVT-stripe-pi-succeeded-0001",
  object: "event",
  type: "payment_intent.succeeded",
  livemode: false,
  created: SEED_STRIPE_TIMESTAMP,
  data: {
    object: {
      id: "SYNTH-PI-0000000001",
      object: "payment_intent",
      amount: 41250,
      currency: "usd",
      status: "succeeded",
      metadata: {
        bookingId: SEED_IDS.booking.flightConfirmed,
        idempotencyKey: "idem-f0000002-flight-confirmed",
      },
    },
  },
  api_version: "2023-10-16",
});

/** payment_intent.payment_failed event body. */
export const SYNTHETIC_WEBHOOK_BODY_FAILED = JSON.stringify({
  id: "SYNTH-EVT-stripe-pi-failed-0001",
  object: "event",
  type: "payment_intent.payment_failed",
  livemode: false,
  created: SEED_STRIPE_TIMESTAMP,
  data: {
    object: {
      id: "SYNTH-PI-0000000002",
      object: "payment_intent",
      amount: 41250,
      currency: "usd",
      status: "requires_payment_method",
      metadata: {
        bookingId: SEED_IDS.booking.pendingActive,
        idempotencyKey: "idem-f0000002-pending-active",
      },
    },
  },
  api_version: "2023-10-16",
});

/** Body with tampered amount — used to test signature-mismatch detection. */
export const SYNTHETIC_WEBHOOK_BODY_TAMPERED = JSON.stringify({
  id: "SYNTH-EVT-stripe-pi-succeeded-0001",
  object: "event",
  type: "payment_intent.succeeded",
  livemode: false,
  created: SEED_STRIPE_TIMESTAMP,
  data: {
    object: {
      id: "SYNTH-PI-0000000001",
      object: "payment_intent",
      amount: 1, // tampered: original was 41250
      currency: "usd",
      status: "succeeded",
      metadata: {
        bookingId: SEED_IDS.booking.flightConfirmed,
        idempotencyKey: "idem-f0000002-flight-confirmed",
      },
    },
  },
  api_version: "2023-10-16",
});

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/**
 * Compute a valid Stripe-Signature header value for the given body and secret.
 *
 * This replicates the algorithm from Stripe's official SDKs so tests can
 * generate valid headers without calling the real Stripe API.
 */
export function makeStripeSignatureHeader(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  const signedPayload = `${timestampSeconds}.${rawBody}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * Produce a header signed with the correct body but with an old timestamp
 * (outside the 5-minute replay window).
 */
export function makeReplayedStripeSignatureHeader(
  rawBody: string,
  secret: string,
  nowSeconds: number,
  ageSeconds = 3600,
): string {
  return makeStripeSignatureHeader(rawBody, secret, nowSeconds - ageSeconds);
}

/**
 * Produce a header with a syntactically valid format but a garbage v1 value.
 */
export function makeMalformedStripeSignatureHeader(timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=00000000000000000000000000000000000000000000000000000000deadbeef`;
}
