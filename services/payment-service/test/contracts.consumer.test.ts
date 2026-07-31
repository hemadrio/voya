/**
 * Consumer-driven fixture test for payment-service.
 * Owner: payment-service team.
 */
import { describe, expect, it } from "vitest";
import {
  PaymentIntentRequestSchema,
  PaymentIntentResponseSchema,
} from "@travel/contracts/payment";
import paymentIntentRequest from "../../../packages/contracts/test/fixtures/payment/payment-intent-request.json" with { type: "json" };
import paymentIntentResponse from "../../../packages/contracts/test/fixtures/payment/payment-intent-response.json" with { type: "json" };

describe("payment-service consumer — PaymentIntentRequest", () => {
  it("fixture validates against PaymentIntentRequestSchema", () => {
    const result = PaymentIntentRequestSchema.safeParse(paymentIntentRequest);
    expect(result.success).toBe(true);
  });

  it("rejects a request with zero amount", () => {
    const result = PaymentIntentRequestSchema.safeParse({ ...paymentIntentRequest, amount: "0.00" });
    expect(result.success).toBe(false);
  });
});

describe("payment-service consumer — PaymentIntentResponse", () => {
  it("fixture validates against PaymentIntentResponseSchema", () => {
    const result = PaymentIntentResponseSchema.safeParse(paymentIntentResponse);
    expect(result.success).toBe(true);
  });

  it("rejects a response with unknown payment status", () => {
    const result = PaymentIntentResponseSchema.safeParse({ ...paymentIntentResponse, status: "AUTHORIZED" });
    expect(result.success).toBe(false);
  });
});
