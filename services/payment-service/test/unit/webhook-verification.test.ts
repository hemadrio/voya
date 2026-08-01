/**
 * Webhook signature verification unit tests (WO-046).
 *
 * Tests the full pipeline from HTTP request to verified event:
 *   - SIGNATURE_VERIFICATION_FAILED error code is returned on all failure paths
 *   - Zero state changes on failure
 *   - Security event writer is called exactly once per failure
 *   - Structured log emits STRIPE_SIGNATURE_INVALID event
 *   - Replay (stale timestamp) returns 400, not 200
 *   - Valid signature succeeds and calls domain
 *   - Missing header returns 400
 *   - Wrong secret returns 400
 *
 * AC9: unit tests for valid, invalid, missing header, tampered body, stale timestamp.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { WebhookVerifier } from "../../src/domain/WebhookVerifier.js";
import { createPaymentRouter } from "../../src/routes/payments.js";
import type { PaymentDomain } from "../../src/routes/payments.js";
import type { WebhookSecurityEventWriter } from "../../src/routes/payments.js";
import { createErrorHandler } from "../../../../shared/middleware/errorHandler.js";
import {
  makeWebhookHeader,
  makeWebhookHeaderNow,
  WEBHOOK_TEST_SECRET,
  WEBHOOK_WRONG_SECRET,
  FIXTURE_PAYMENT_SUCCEEDED,
  FIXTURE_PAYMENT_FAILED,
  FIXTURE_CHARGE_REFUNDED,
  FIXTURE_PAYMENT_SUCCEEDED_TAMPERED,
  SIG_PAYMENT_SUCCEEDED,
  SIG_PAYMENT_FAILED,
  SIG_CHARGE_REFUNDED,
  SIG_PAYMENT_SUCCEEDED_STALE,
  SIG_PAYMENT_SUCCEEDED_WRONG_SECRET,
  WEBHOOK_FIXED_TIMESTAMP,
} from "../fixtures/webhook-fixtures.js";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeTestApp(
  domain: PaymentDomain,
  writer?: WebhookSecurityEventWriter,
) {
  const app = express();
  // Correct ordering: raw before JSON (mirrors app.ts)
  app.use("/payments/webhook", express.raw({ type: "application/json" }));
  app.use(express.json({ limit: "64kb" }));
  app.use("/payments", createPaymentRouter(domain, undefined, writer));
  app.use(createErrorHandler());
  return app;
}

function makeDomain(handleFn?: (body: Buffer, sig: string) => Promise<void>): PaymentDomain {
  return {
    createIntent: vi.fn(async () => ({})),
    handleWebhook: vi.fn(handleFn ?? (async () => {})),
  };
}

function makeVerifier(clock?: () => number): WebhookVerifier {
  return new WebhookVerifier({
    signingSecret: WEBHOOK_TEST_SECRET,
    clock: clock ?? (() => WEBHOOK_FIXED_TIMESTAMP),
    toleranceSeconds: 300,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC9: valid signature → 200, domain called
// ---------------------------------------------------------------------------

describe("Valid webhook signature", () => {
  it("returns 200 and calls domain.handleWebhook for payment_intent.succeeded", async () => {
    const domain = makeDomain();
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED)
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(domain.handleWebhook).toHaveBeenCalledOnce();
  });

  it("returns 200 for payment_intent.payment_failed fixture", async () => {
    const domain = makeDomain();
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_FAILED)
      .send(FIXTURE_PAYMENT_FAILED);

    expect(res.status).toBe(200);
    expect(domain.handleWebhook).toHaveBeenCalledOnce();
  });

  it("returns 200 for charge.refunded fixture", async () => {
    const domain = makeDomain();
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_CHARGE_REFUNDED)
      .send(FIXTURE_CHARGE_REFUNDED);

    expect(res.status).toBe(200);
    expect(domain.handleWebhook).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// AC4: missing header → 400 SIGNATURE_VERIFICATION_FAILED
// ---------------------------------------------------------------------------

describe("Missing stripe-signature header", () => {
  it("returns 400 SIGNATURE_VERIFICATION_FAILED when header is absent", async () => {
    const domain = makeDomain();
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    // AC4: missing header must return SIGNATURE_VERIFICATION_FAILED, not VALIDATION_FAILED.
    // The pre-check in the webhook route (not validateWebhookHeaders) handles this.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SIGNATURE_VERIFICATION_FAILED");
    expect(domain.handleWebhook).not.toHaveBeenCalled();
  });

  it("performs zero state changes — domain.handleWebhook never called on missing header", async () => {
    const domain = makeDomain();
    const app = makeTestApp(domain);

    await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    expect(domain.handleWebhook).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC4: SIGNATURE_VERIFICATION_FAILED via domain.handleWebhook throwing
// ---------------------------------------------------------------------------

describe("Invalid signature from WebhookVerifier → SIGNATURE_VERIFICATION_FAILED", () => {
  it("returns 400 SIGNATURE_VERIFICATION_FAILED when verifier throws on tampered body", async () => {
    const verifier = makeVerifier();

    const domain = makeDomain(async (body: Buffer, sig: string) => {
      verifier.verify(body, sig);
    });
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED) // sig for original body
      .send(FIXTURE_PAYMENT_SUCCEEDED_TAMPERED);      // tampered body

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SIGNATURE_VERIFICATION_FAILED");
    expect(res.body.error.message).not.toContain(WEBHOOK_TEST_SECRET);
  });

  it("returns 400 SIGNATURE_VERIFICATION_FAILED on wrong secret", async () => {
    const verifier = makeVerifier();

    const domain = makeDomain(async (body: Buffer, sig: string) => {
      verifier.verify(body, sig);
    });
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED_WRONG_SECRET)
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SIGNATURE_VERIFICATION_FAILED");
  });

  it("zero state changes — handleWebhook called once but domain throws before any mutation", async () => {
    let stateChanged = false;
    const verifier = makeVerifier();

    const domain = makeDomain(async (body: Buffer, sig: string) => {
      verifier.verify(body, sig); // throws on invalid sig
      stateChanged = true;        // never reached
    });
    const app = makeTestApp(domain);

    await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED_WRONG_SECRET)
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    expect(stateChanged).toBe(false);
  });

  it("calls security event writer exactly once per failure", async () => {
    const verifier = makeVerifier();
    const events: unknown[] = [];
    const writer: WebhookSecurityEventWriter = {
      writeSignatureFailure: vi.fn((info) => { events.push(info); }),
    };

    const domain = makeDomain(async (body: Buffer, sig: string) => {
      verifier.verify(body, sig);
    });
    const app = makeTestApp(domain, writer);

    await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED_WRONG_SECRET)
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    expect(writer.writeSignatureFailure).toHaveBeenCalledOnce();
    const call = (writer.writeSignatureFailure as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['signaturePresent']).toBe(true);
    expect(JSON.stringify(call)).not.toContain(WEBHOOK_TEST_SECRET);
    expect(JSON.stringify(call)).not.toContain(WEBHOOK_WRONG_SECRET);
  });

  it("emits STRIPE_SIGNATURE_INVALID to stdout for CloudWatch metric filter", async () => {
    const verifier = makeVerifier();
    const stdoutLines: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    const domain = makeDomain(async (body: Buffer, sig: string) => {
      verifier.verify(body, sig);
    });
    const app = makeTestApp(domain);

    await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED_WRONG_SECRET)
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    stdoutSpy.mockRestore();

    const logLine = stdoutLines.find((l) => l.includes("STRIPE_SIGNATURE_INVALID"));
    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine!.trim());
    expect(parsed.event).toBe("STRIPE_SIGNATURE_INVALID");
    // Signing secret must not appear in the log
    expect(logLine).not.toContain(WEBHOOK_TEST_SECRET);
    expect(logLine).not.toContain(WEBHOOK_WRONG_SECRET);
  });

  it("does not echo request body in error response", async () => {
    const verifier = makeVerifier();
    const domain = makeDomain(async (body: Buffer, sig: string) => {
      verifier.verify(body, sig);
    });
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED_WRONG_SECRET)
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    expect(JSON.stringify(res.body)).not.toContain("SYNTH-EVT");
    expect(JSON.stringify(res.body)).not.toContain("payment_intent");
  });
});

// ---------------------------------------------------------------------------
// AC5: replay (stale timestamp) → 400
// ---------------------------------------------------------------------------

describe("Replay detection — stale timestamp", () => {
  it("rejects a webhook signed with a timestamp 2 hours in the past", async () => {
    const verifier = makeVerifier();

    const domain = makeDomain(async (body: Buffer, sig: string) => {
      verifier.verify(body, sig);
    });
    const app = makeTestApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", SIG_PAYMENT_SUCCEEDED_STALE)
      .send(FIXTURE_PAYMENT_SUCCEEDED);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SIGNATURE_VERIFICATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// WebhookVerifier unit tests — SIGNATURE_VERIFICATION_FAILED code (AC9)
// ---------------------------------------------------------------------------

describe("WebhookVerifier — throws SIGNATURE_VERIFICATION_FAILED", () => {
  it("throws with code SIGNATURE_VERIFICATION_FAILED for missing header", () => {
    const verifier = makeVerifier();
    let thrownCode: string | undefined;
    try {
      verifier.verify(FIXTURE_PAYMENT_SUCCEEDED, undefined);
    } catch (err) {
      thrownCode = (err as { code?: string }).code;
    }
    expect(thrownCode).toBe("SIGNATURE_VERIFICATION_FAILED");
  });

  it("throws with code SIGNATURE_VERIFICATION_FAILED for tampered body", () => {
    const verifier = makeVerifier();
    let thrownCode: string | undefined;
    try {
      verifier.verify(FIXTURE_PAYMENT_SUCCEEDED_TAMPERED, SIG_PAYMENT_SUCCEEDED);
    } catch (err) {
      thrownCode = (err as { code?: string }).code;
    }
    expect(thrownCode).toBe("SIGNATURE_VERIFICATION_FAILED");
  });

  it("throws with code SIGNATURE_VERIFICATION_FAILED for wrong secret", () => {
    const verifier = makeVerifier();
    let thrownCode: string | undefined;
    try {
      verifier.verify(FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED_WRONG_SECRET);
    } catch (err) {
      thrownCode = (err as { code?: string }).code;
    }
    expect(thrownCode).toBe("SIGNATURE_VERIFICATION_FAILED");
  });

  it("throws with code SIGNATURE_VERIFICATION_FAILED for stale timestamp", () => {
    const verifier = makeVerifier();
    let thrownCode: string | undefined;
    try {
      verifier.verify(FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED_STALE);
    } catch (err) {
      thrownCode = (err as { code?: string }).code;
    }
    expect(thrownCode).toBe("SIGNATURE_VERIFICATION_FAILED");
  });

  it("does NOT throw for valid signature (returns ParsedStripeEvent)", () => {
    const verifier = makeVerifier();
    const event = verifier.verify(FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED);
    expect(event.type).toBe("payment_intent.succeeded");
    expect(event.id).toBe("SYNTH-EVT-0001");
  });
});
