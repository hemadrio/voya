/**
 * Stripe webhook payload fixtures.
 *
 * The signature header value is a placeholder — it does NOT correspond to
 * any real Stripe signing secret and will fail signature verification
 * intentionally. Tests that exercise webhook signature verification must
 * generate a valid signature using the test signing secret from the local
 * Secrets Manager seed.
 */

import { SEED_IDS, SEED_REFERENCE_INSTANT } from "../identifiers.js";

/** Raw Stripe payment_intent.succeeded webhook event body. */
export const SYNTHETIC_STRIPE_WEBHOOK_BODY = JSON.stringify({
  id: "SYNTH-EVT-stripe-pi-succeeded-0001",
  object: "event",
  type: "payment_intent.succeeded",
  livemode: false,
  created: Math.floor(SEED_REFERENCE_INSTANT.getTime() / 1000),
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

/**
 * Placeholder Stripe-Signature header value.
 * Replace this with a real computed signature in tests that exercise
 * the stripe.webhooks.constructEvent() path.
 */
export const SYNTHETIC_STRIPE_SIGNATURE_HEADER =
  "t=1000000000,v1=0000000000000000000000000000000000000000000000000000000000000000";

/** PaymentIntentRequest fixture. */
export const SYNTHETIC_PAYMENT_INTENT_REQUEST = {
  bookingId: SEED_IDS.booking.flightConfirmed,
  amount: "412.50",
  currency: "USD",
  idempotencyKey: "idem-f0000002-flight-confirmed",
};

/** PaymentIntentResponse fixture — as returned by payment-service before Stripe confirmation. */
export const SYNTHETIC_PAYMENT_INTENT_RESPONSE = {
  id: "SYNTH-PI-0000000001",
  bookingId: SEED_IDS.booking.flightConfirmed,
  clientSecret: "SYNTH-PI-0000000001_secret_0000000000000000",
  status: "REQUIRES_PAYMENT_METHOD" as const,
  amount: "412.50",
  currency: "USD",
};
