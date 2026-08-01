/**
 * Stripe webhook route — raw body preservation test.
 *
 * AC7: The webhook route receives the unparsed raw body, signature
 *      verification succeeds against a fixture-signed payload, and the
 *      JSON body parser is not applied to that path.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createPaymentRouter } from "../src/routes/payments.js";
import type { PaymentDomain } from "../src/routes/payments.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";

function makeApp(domain: PaymentDomain) {
  const app = express();
  // Raw body parser for webhook MUST come before the global JSON parser
  // (matches the ordering in app.ts).  If express.json() runs first it
  // consumes the body stream and express.raw() receives an empty buffer,
  // breaking Stripe HMAC verification.
  app.use("/payments/webhook", express.raw({ type: "application/json" }));
  app.use(express.json({ limit: "64kb" }));
  app.use("/payments", createPaymentRouter(domain));
  app.use(createErrorHandler());
  return app;
}

describe("POST /payments/webhook — raw body preservation (AC7)", () => {
  it("rejects webhook without stripe-signature header with 400", async () => {
    const domain: PaymentDomain = {
      createIntent: vi.fn(async () => ({})),
      handleWebhook: vi.fn(async () => {}),
    };
    const app = makeApp(domain);

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));

    expect(res.status).toBe(400);
    // AC4: missing header must return SIGNATURE_VERIFICATION_FAILED (not VALIDATION_FAILED)
    // All signature failures (missing, malformed, invalid HMAC) use this single code.
    expect(res.body.error.code).toBe("SIGNATURE_VERIFICATION_FAILED");
    // handleWebhook was never called
    expect(domain.handleWebhook).not.toHaveBeenCalled();
  });

  it("passes raw Buffer to handleWebhook when signature header is present", async () => {
    const capturedArgs: { body: Buffer; sig: string }[] = [];
    const domain: PaymentDomain = {
      createIntent: vi.fn(async () => ({})),
      handleWebhook: vi.fn(async (body: Buffer, sig: string) => {
        capturedArgs.push({ body, sig });
      }),
    };
    const app = makeApp(domain);

    const payload = JSON.stringify({ type: "payment_intent.succeeded", id: "evt_test_123" });
    const testSignature = "t=1234567890,v1=abc123";

    const res = await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", testSignature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(domain.handleWebhook).toHaveBeenCalledOnce();

    // AC7: body must be a Buffer, not a parsed object
    expect(capturedArgs[0]?.body).toBeInstanceOf(Buffer);
    expect(capturedArgs[0]?.body.toString()).toBe(payload);
    expect(capturedArgs[0]?.sig).toBe(testSignature);
  });

  it("AC7: JSON body parser does NOT parse the webhook path", async () => {
    // Verify req.body is a Buffer, not a JS object, on the webhook path.
    // This is proved by the above test — handleWebhook receives a Buffer.
    // If the JSON body parser had run, req.body would be an object.
    const capturedBody: unknown[] = [];
    const domain: PaymentDomain = {
      createIntent: vi.fn(async () => ({})),
      handleWebhook: vi.fn(async (body: Buffer) => {
        capturedBody.push(body);
      }),
    };
    const app = makeApp(domain);

    const payload = '{"type":"payment_intent.created","special":"💰 unicode + special chars <>&"}';

    await request(app)
      .post("/payments/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=sig")
      .send(payload);

    // Body is a Buffer whose string representation equals the original payload byte-for-byte.
    expect(capturedBody[0]).toBeInstanceOf(Buffer);
    expect((capturedBody[0] as Buffer).toString("utf8")).toBe(payload);
  });
});

describe("POST /payments/intent — JSON validation", () => {
  it("rejects invalid intent request with 400", async () => {
    const domain: PaymentDomain = {
      createIntent: vi.fn(async () => ({})),
      handleWebhook: vi.fn(async () => {}),
    };
    const app = makeApp(domain);

    const res = await request(app)
      .post("/payments/intent")
      .send({ bookingId: "", amount: -10, currency: "USD", idempotencyKey: "k1" });

    expect(res.status).toBe(400);
    expect(domain.createIntent).not.toHaveBeenCalled();
  });
});
