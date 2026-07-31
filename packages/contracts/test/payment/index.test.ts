import { describe, expect, it } from "vitest";
import { PaymentIntentRequestSchema, PaymentIntentResponseSchema } from "../../src/payment/index.js";
import requestFixture from "../fixtures/payment/payment-intent-request.json" with { type: "json" };
import responseFixture from "../fixtures/payment/payment-intent-response.json" with { type: "json" };

describe("PaymentIntentRequestSchema", () => {
  it("accepts the committed fixture", () => {
    expect(PaymentIntentRequestSchema.safeParse(requestFixture).success).toBe(true);
  });

  it("rejects a zero amount", () => {
    const result = PaymentIntentRequestSchema.safeParse({ ...requestFixture, amount: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a missing idempotencyKey", () => {
    const { idempotencyKey: _idempotencyKey, ...rest } = requestFixture as Record<string, unknown>;
    expect(PaymentIntentRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects unknown extra keys", () => {
    expect(PaymentIntentRequestSchema.safeParse({ ...requestFixture, extra: "nope" }).success).toBe(false);
  });
});

describe("PaymentIntentResponseSchema", () => {
  it("accepts the committed fixture", () => {
    expect(PaymentIntentResponseSchema.safeParse(responseFixture).success).toBe(true);
  });

  it("rejects an invalid payment status", () => {
    const result = PaymentIntentResponseSchema.safeParse({ ...responseFixture, status: "UNKNOWN" });
    expect(result.success).toBe(false);
  });
});
