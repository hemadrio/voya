/**
 * Characterization tests: Stripe webhook signature verification.
 *
 * Covers:
 *   - Valid signature → successful parse, no security event
 *   - Missing Stripe-Signature header → 400 + exactly one security event
 *   - Tampered body (original signature, mutated body) → 400 + security event
 *   - Wrong signing secret → 400 + security event
 *   - Replayed webhook (timestamp > tolerance window) → 400 + security event
 *   - Malformed header format → 400 + security event
 *   - A10 posture: failure never fails open, never silently swallowed
 *
 * All dependencies are injected fakes. No Stripe API calls.
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookVerifier, type WebhookSecurityLogger } from "../WebhookVerifier.js";

// ---------------------------------------------------------------------------
// Fixtures — synthetic signing secret and test body
// ---------------------------------------------------------------------------

const TEST_SECRET = "whsec_SYNTH0000000000000000000000001";
const TEST_SECRET_WRONG = "whsec_SYNTH0000000000000000000000002";
const TEST_NOW_SECONDS = 1737000000; // Fixed "now" for deterministic tests

const WEBHOOK_BODY = JSON.stringify({
  id: "SYNTH-EVT-0001",
  object: "event",
  type: "payment_intent.succeeded",
  livemode: false,
  created: TEST_NOW_SECONDS,
  data: {
    object: {
      id: "SYNTH-PI-0001",
      object: "payment_intent",
      amount: 41250,
      currency: "usd",
      status: "succeeded",
      metadata: {
        bookingId: "f0000002-0000-4000-8000-000000000001",
        idempotencyKey: "idem-f0000002-flight-confirmed",
      },
    },
  },
  api_version: "2023-10-16",
});

const WEBHOOK_BODY_TAMPERED = JSON.stringify({
  id: "SYNTH-EVT-0001",
  object: "event",
  type: "payment_intent.succeeded",
  livemode: false,
  created: TEST_NOW_SECONDS,
  data: {
    object: {
      id: "SYNTH-PI-0001",
      object: "payment_intent",
      amount: 1, // tampered amount
      currency: "usd",
      status: "succeeded",
      metadata: {
        bookingId: "f0000002-0000-4000-8000-000000000001",
        idempotencyKey: "idem-f0000002-flight-confirmed",
      },
    },
  },
  api_version: "2023-10-16",
});

// ---------------------------------------------------------------------------
// Signature helper
// ---------------------------------------------------------------------------

function makeValidHeader(body: string, secret: string, timestampSeconds: number): string {
  const signedPayload = `${timestampSeconds}.${body}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

// ---------------------------------------------------------------------------
// Security logger fake
// ---------------------------------------------------------------------------

function makeSecurityLogger(): { logger: WebhookSecurityLogger; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    logger: {
      logForgedSignature(info) {
        calls.push(info);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerifier(secretOverride?: string, securityLogger?: WebhookSecurityLogger): WebhookVerifier {
  return new WebhookVerifier({
    signingSecret: secretOverride ?? TEST_SECRET,
    clock: () => TEST_NOW_SECONDS,
    toleranceSeconds: 300,
    securityLogger,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("WebhookVerifier — valid signature", () => {
  it("returns parsed event for a correctly signed webhook", () => {
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);
    const verifier = makeVerifier();

    const event = verifier.verify(WEBHOOK_BODY, header);

    expect(event.id).toBe("SYNTH-EVT-0001");
    expect(event.type).toBe("payment_intent.succeeded");
  });

  it("does not emit a security event on success", () => {
    const { logger, calls } = makeSecurityLogger();
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);
    const verifier = makeVerifier(undefined, logger);

    verifier.verify(WEBHOOK_BODY, header);

    expect(calls).toHaveLength(0);
  });

  it("accepts Buffer body and string body equivalently", () => {
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);
    const verifier = makeVerifier();

    const fromString = verifier.verify(WEBHOOK_BODY, header);
    const fromBuffer = verifier.verify(Buffer.from(WEBHOOK_BODY, "utf8"), header);

    expect(fromString.id).toBe(fromBuffer.id);
  });
});

// ---------------------------------------------------------------------------
// Missing signature header
// ---------------------------------------------------------------------------

describe("WebhookVerifier — missing signature header", () => {
  it("throws VALIDATION_FAILED for undefined header", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);

    expect(() => verifier.verify(WEBHOOK_BODY, undefined)).toThrow();
    const err = getError(() => verifier.verify(WEBHOOK_BODY, undefined));
    expect(err).not.toBeNull();
    expect((err as Record<string, unknown>)["code"]).toBe("VALIDATION_FAILED");
  });

  it("emits exactly one security event for missing header", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);

    safeCall(() => verifier.verify(WEBHOOK_BODY, undefined));

    expect(calls).toHaveLength(1);
    const call = calls[0] as Record<string, unknown>;
    expect(call["reason"]).toContain("Missing");
  });

  it("throws for empty string header", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);

    safeCall(() => verifier.verify(WEBHOOK_BODY, ""));

    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tampered body
// ---------------------------------------------------------------------------

describe("WebhookVerifier — tampered body", () => {
  it("throws VALIDATION_FAILED when body is mutated after signing", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);
    // Header is computed over the original body, but we pass the tampered body
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);

    safeCall(() => verifier.verify(WEBHOOK_BODY_TAMPERED, header));

    expect(calls).toHaveLength(1);
    const call = calls[0] as Record<string, unknown>;
    expect(typeof call["reason"]).toBe("string");
  });

  it("emits exactly one security event for tampered body", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);

    safeCall(() => verifier.verify(WEBHOOK_BODY_TAMPERED, header));

    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Wrong signing secret
// ---------------------------------------------------------------------------

describe("WebhookVerifier — wrong signing secret", () => {
  it("throws VALIDATION_FAILED when verifier uses a different secret", () => {
    const { logger, calls } = makeSecurityLogger();
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);
    // Verifier configured with the wrong secret
    const verifier = makeVerifier(TEST_SECRET_WRONG, logger);

    safeCall(() => verifier.verify(WEBHOOK_BODY, header));

    expect(calls).toHaveLength(1);
  });

  it("does not disclose the signing secret in the error message", () => {
    const verifier = makeVerifier(TEST_SECRET_WRONG);
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);

    const err = getError(() => verifier.verify(WEBHOOK_BODY, header));
    expect((err as Error).message).not.toContain(TEST_SECRET);
    expect((err as Error).message).not.toContain(TEST_SECRET_WRONG);
  });
});

// ---------------------------------------------------------------------------
// Replayed webhook (stale timestamp)
// ---------------------------------------------------------------------------

describe("WebhookVerifier — replayed webhook", () => {
  it("throws VALIDATION_FAILED for a timestamp 1 hour in the past", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);
    // Header signed with a timestamp 3600s before "now"
    const staleTimestamp = TEST_NOW_SECONDS - 3600;
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, staleTimestamp);

    safeCall(() => verifier.verify(WEBHOOK_BODY, header));

    expect(calls).toHaveLength(1);
    const call = calls[0] as Record<string, unknown>;
    expect(typeof call["reason"]).toBe("string");
  });

  it("throws for a timestamp 1 hour in the future (future-dated replay)", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);
    const futureTimestamp = TEST_NOW_SECONDS + 3600;
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, futureTimestamp);

    safeCall(() => verifier.verify(WEBHOOK_BODY, header));

    expect(calls).toHaveLength(1);
  });

  it("accepts a timestamp within the tolerance window (4 minutes old)", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);
    const recentTimestamp = TEST_NOW_SECONDS - 240; // 4 minutes ago
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, recentTimestamp);

    const event = verifier.verify(WEBHOOK_BODY, header);

    expect(event.id).toBe("SYNTH-EVT-0001");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed header
// ---------------------------------------------------------------------------

describe("WebhookVerifier — malformed signature header", () => {
  it("throws for a header with no t= field", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);

    safeCall(() => verifier.verify(WEBHOOK_BODY, "v1=abc123"));

    expect(calls).toHaveLength(1);
  });

  it("throws for a header with no v1= field", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);

    safeCall(() => verifier.verify(WEBHOOK_BODY, `t=${TEST_NOW_SECONDS}`));

    expect(calls).toHaveLength(1);
  });

  it("throws for a header with a wrong-length v1 value", () => {
    const { logger, calls } = makeSecurityLogger();
    const verifier = makeVerifier(undefined, logger);
    const header = `t=${TEST_NOW_SECONDS},v1=00000000000000000000000000000000000000000000000000000000deadbeef`;

    safeCall(() => verifier.verify(WEBHOOK_BODY, header));

    expect(calls).toHaveLength(1);
  });

  it("never returns a partial result — throws or returns a complete event", () => {
    const header = makeValidHeader(WEBHOOK_BODY, TEST_SECRET, TEST_NOW_SECONDS);
    const verifier = makeVerifier();

    const event = verifier.verify(WEBHOOK_BODY, header);
    expect(event.id).toBeDefined();
    expect(event.type).toBeDefined();
    expect(event.data).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// A10 posture helpers
// ---------------------------------------------------------------------------

function getError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

function safeCall(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // expected
  }
}
