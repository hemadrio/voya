/**
 * Committed fault stubs and canned responses for deterministic resilience
 * scenarios (WO-099 AC16).
 *
 * All fixtures are synthetic — no real credentials, booking IDs, or PII.
 * Supplier responses simulate the full range of failure modes.
 */

import type { NormalisedOffer } from "@travel/supplier-resilience";

// ---------------------------------------------------------------------------
// Synthetic constants
// ---------------------------------------------------------------------------

export const SYNTH_CORR_ID = "resilience-test-corr-001";
export const SYNTH_SUPPLIER_A = "synth-supplier-a";
export const SYNTH_SUPPLIER_B = "synth-supplier-b";
export const SYNTH_SUPPLIER_C = "synth-supplier-c";

// ---------------------------------------------------------------------------
// Canned supplier offer responses
// ---------------------------------------------------------------------------

export const OFFER_SUPPLIER_A: NormalisedOffer = {
  offerId: "offer-a-001",
  supplierName: SYNTH_SUPPLIER_A,
  price: { amount: 299.99, currency: "USD" },
  vertical: "flight",
};

export const OFFER_SUPPLIER_B: NormalisedOffer = {
  offerId: "offer-b-001",
  supplierName: SYNTH_SUPPLIER_B,
  price: { amount: 349.00, currency: "USD" },
  vertical: "flight",
};

// ---------------------------------------------------------------------------
// Webhook fault fixtures
// ---------------------------------------------------------------------------

/** A forged webhook with no Stripe-Signature header value */
export const FORGED_WEBHOOK_NO_SIG = {
  body: JSON.stringify({
    id: "SYNTH-FORGED-001",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_forged", amount: 9999, currency: "usd" } },
  }),
  signature: "", // intentionally empty
};

/** A tampered webhook — body modified after signing */
export const TAMPERED_WEBHOOK = {
  originalBody: JSON.stringify({
    id: "SYNTH-TAMPERED-001",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_tampered", amount: 1, currency: "usd" } },
  }),
  tamperedBody: JSON.stringify({
    id: "SYNTH-TAMPERED-001",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_tampered", amount: 99999, currency: "usd" } }, // amount changed after signing
  }),
};

/** A replay of a previously processed event (same ID, resent) */
export const REPLAY_WEBHOOK_ID = "SYNTH-REPLAY-001";
export const REPLAY_WEBHOOK_BODY = JSON.stringify({
  id: REPLAY_WEBHOOK_ID,
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_SYNTH_REPLAY",
      amount: 49999,
      currency: "usd",
      metadata: { bookingId: "f0000020-0000-4000-8000-000000000001" },
    },
  },
});

// ---------------------------------------------------------------------------
// Placeholder secret fixtures (obviously fake — never resemble real credentials)
// ---------------------------------------------------------------------------

/** A known placeholder value from the PLACEHOLDER_BLOCKLIST */
export const PLACEHOLDER_SECRET_VALUE = "dev-secret-change-me";

/** An absent secret (env var not set) */
export const ABSENT_SECRET_ENV_VAR = "SYNTH_REQUIRED_SECRET_MISSING";

/** An empty string secret (must be treated as missing) */
export const EMPTY_SECRET_VALUE = "";

// ---------------------------------------------------------------------------
// Rate limiting burst
// ---------------------------------------------------------------------------

/** Number of requests in the burst that should trigger the WAF limit */
export const WAF_BURST_COUNT = 2001; // one over the 2000/5min limit
export const WAF_RATE_LIMIT_WINDOW_SECONDS = 300;

// ---------------------------------------------------------------------------
// SSRF test targets
// ---------------------------------------------------------------------------

/** User-controlled URLs that must be blocked by the allow-list */
export const SSRF_DISALLOWED_URLS = [
  "http://169.254.169.254/latest/meta-data/",           // AWS metadata endpoint
  "http://localhost:5432/",                              // internal postgres
  "http://127.0.0.1:6379/",                             // internal redis
  "file:///etc/passwd",                                  // local filesystem
  "http://10.0.0.1/",                                   // RFC1918 private range
  "http://192.168.1.1/",                                // RFC1918 private range
  "http://internal-rds-proxy.cluster.local/",           // internal DNS name
];

/** User-controlled URL that IS on the allow-list (positive control) */
export const SSRF_ALLOWED_URL = "https://api.stripe.com/v1/payment_intents";
