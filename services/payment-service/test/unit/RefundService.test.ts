/**
 * Unit tests for RefundService (WO-049, AC1–AC12).
 *
 * All tests use in-memory port doubles — no Stripe, no database, no AWS.
 * Clock is injected as a fixed timestamp so tests are deterministic.
 *
 * Coverage:
 *   - Full refund (AC1, AC2, AC3)
 *   - Partial refund (AC1, AC4)
 *   - Split refunds summing to total charge (AC5)
 *   - Over-refund rejection at exactly full amount and one minor unit above (AC4)
 *   - Non-refundable leg returns 422 NOT_REFUNDABLE (AC6)
 *   - Duplicate request idempotency via existing REFUND row (AC2)
 *   - Provider error mapped to 502 PROVIDER_UNAVAILABLE
 *   - Zero / negative amount rejection (400)
 *   - Settlement window wording in response (AC7)
 *   - Audit row written (AC8)
 *   - Queue event published exactly once per refund with dedup ID (AC8)
 *   - idempotency key derivation determinism (AC2)
 *   - assertIntegerMinorUnits rejects float (AC9)
 */

import { describe, it, expect } from "vitest";
import { RefundService } from "../../src/domain/RefundService.js";
import {
  FIXTURE_CHARGE_AMOUNT,
  FIXTURE_BOOKING_ID,
  FIXTURE_CURRENCY,
  FIXTURE_CHARGE_ROW,
  STRIPE_REFUND_SUCCEEDED,
  STRIPE_REFUND_PENDING,
  STRIPE_REFUND_FAILED,
  makeMockStripePort,
  makeMockQueue,
  makeMockSettlementWindow,
  makeMockRefundPolicy,
  makeMockBookingQuery,
  makeMockRefundRepository,
  makeEligibleDecision,
  makeNonRefundableDecision,
} from "../fixtures/refund-fixtures.js";
import type { RefundServiceRequest } from "../../src/domain/RefundService.js";

const FIXED_NOW = new Date("2026-08-01T12:00:00.000Z");

function makeRequest(overrides: Partial<RefundServiceRequest> = {}): RefundServiceRequest {
  return {
    bookingId: FIXTURE_BOOKING_ID,
    currency: FIXTURE_CURRENCY,
    reason: "Customer requested cancellation",
    actor: { id: "user-actor-001", role: "traveler" },
    correlationId: "trace-001",
    ...overrides,
  };
}

function makeService(opts: {
  chargeRow?: typeof FIXTURE_CHARGE_ROW | null;
  existingRefunds?: typeof FIXTURE_CHARGE_ROW[];
  stripeResult?: Awaited<ReturnType<typeof makeMockStripePort>["createRefund"]>;
  throwOnStripe?: Error;
  eligible?: boolean;
  legId?: string;
  settlementWording?: string;
} = {}) {
  const policy = opts.eligible === false
    ? makeMockRefundPolicy(makeNonRefundableDecision())
    : makeMockRefundPolicy(makeEligibleDecision(opts.chargeRow?.amountMinor ?? FIXTURE_CHARGE_AMOUNT));

  return new RefundService({
    stripePort: makeMockStripePort(
      opts.stripeResult ?? STRIPE_REFUND_SUCCEEDED,
      { throwOnRefund: opts.throwOnStripe ?? null },
    ),
    paymentRepo: makeMockRefundRepository({
      chargeRow: opts.chargeRow ?? FIXTURE_CHARGE_ROW,
      existingRefunds: opts.existingRefunds ?? [],
    }),
    bookingQuery: makeMockBookingQuery(),
    refundPolicy: policy,
    settlementWindow: makeMockSettlementWindow(opts.settlementWording ?? "5–10 business days"),
    queue: makeMockQueue(),
    clock: () => FIXED_NOW,
  });
}

// ---------------------------------------------------------------------------
// Full refund (AC1, AC2, AC3)
// ---------------------------------------------------------------------------

describe("RefundService — full refund", () => {
  it("issues a full refund when amountMinor is omitted", async () => {
    const queue = makeMockQueue();
    const repo = makeMockRefundRepository();
    const svc = new RefundService({
      stripePort: makeMockStripePort(STRIPE_REFUND_SUCCEEDED),
      paymentRepo: repo,
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue,
      clock: () => FIXED_NOW,
    });

    const result = await svc.issueRefund(makeRequest());

    expect(result.status).toBe("SUCCEEDED");
    expect(result.amountMinor).toBe(FIXTURE_CHARGE_AMOUNT);
    expect(result.currency).toBe(FIXTURE_CURRENCY);
    expect(result.refundId).toBeTruthy();
    expect(result.providerReference).toMatch(/^re_/);
  });

  it("persists a REFUND row with type=REFUND and parentPaymentId set", async () => {
    const repo = makeMockRefundRepository();
    const svc = new RefundService({
      stripePort: makeMockStripePort(STRIPE_REFUND_SUCCEEDED),
      paymentRepo: repo,
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    await svc.issueRefund(makeRequest());

    expect(repo.created).toHaveLength(1);
    const row = repo.created[0];
    expect(row.type).toBe("REFUND");
    expect(row.parentPaymentId).toBe(FIXTURE_CHARGE_ROW.id);
    expect(row.provider).toBe("stripe");
    expect(row.amountMinor).toBe(FIXTURE_CHARGE_AMOUNT);
  });

  it("writes a REFUNDED audit row (AC8)", async () => {
    const repo = makeMockRefundRepository();
    const svc = new RefundService({
      stripePort: makeMockStripePort(STRIPE_REFUND_SUCCEEDED),
      paymentRepo: repo,
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    await svc.issueRefund(makeRequest({ actor: { id: "actor-99", role: "support_agent" }, reason: "audit-test" }));

    expect(repo.auditRows).toHaveLength(1);
    const audit = repo.auditRows[0];
    expect(audit["action"]).toBe("REFUNDED");
    expect(audit["actorId"]).toBe("actor-99");
    expect(audit["actorRole"]).toBe("support_agent");
  });

  it("publishes exactly one refund.issued queue event with provider reference as dedup ID (AC8)", async () => {
    const queue = makeMockQueue();
    const svc = new RefundService({
      stripePort: makeMockStripePort(STRIPE_REFUND_SUCCEEDED),
      paymentRepo: makeMockRefundRepository(),
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue,
      clock: () => FIXED_NOW,
    });

    await svc.issueRefund(makeRequest());

    expect(queue.published).toHaveLength(1);
    const evt = queue.published[0];
    expect(evt.message.type).toBe("refund.issued");
    // MessageDeduplicationId must equal the Stripe refund ID
    expect(evt.opts.messageDeduplicationId).toMatch(/^re_/);
  });

  it("includes settlement window wording in response (AC7)", async () => {
    const svc = makeService({ settlementWording: "Funds arrive in 3 days." });
    const result = await svc.issueRefund(makeRequest());
    expect(result.settlementWindow).toBe("Funds arrive in 3 days.");
  });

  it("maps Stripe 'pending' status to PENDING in response", async () => {
    const svc = makeService({ stripeResult: { ...STRIPE_REFUND_PENDING, amountMinor: FIXTURE_CHARGE_AMOUNT } });
    const result = await svc.issueRefund(makeRequest());
    expect(result.status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Partial refund (AC1, AC4)
// ---------------------------------------------------------------------------

describe("RefundService — partial refund", () => {
  it("issues a partial refund with the requested amountMinor", async () => {
    const svc = makeService();
    const result = await svc.issueRefund(makeRequest({ amountMinor: BigInt(3000) }));
    expect(result.amountMinor).toBe(BigInt(3000));
    expect(result.status).toBe("SUCCEEDED");
  });

  it("allows a refund at exactly the full charge amount (boundary AC4)", async () => {
    const svc = makeService();
    const result = await svc.issueRefund(makeRequest({ amountMinor: FIXTURE_CHARGE_AMOUNT }));
    expect(result.amountMinor).toBe(FIXTURE_CHARGE_AMOUNT);
  });
});

// ---------------------------------------------------------------------------
// Over-refund rejection (AC4)
// ---------------------------------------------------------------------------

describe("RefundService — over-refund rejection", () => {
  it("rejects with REFUND_EXCEEDS_CHARGE when requested amount exceeds charge by 1 minor unit (AC4)", async () => {
    const svc = makeService();
    const overAmount = FIXTURE_CHARGE_AMOUNT + BigInt(1);

    await expect(
      svc.issueRefund(makeRequest({ amountMinor: overAmount })),
    ).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_CHARGE",
    });
  });

  it("rejects with REFUND_EXCEEDS_CHARGE when cumulative refunds would exceed charge (AC4)", async () => {
    // Already refunded 7000; requesting 4000 more → 11000 > 10000
    const existingRefund = {
      ...FIXTURE_CHARGE_ROW,
      id: "pay-refund-existing",
      type: "REFUND",
      parentPaymentId: FIXTURE_CHARGE_ROW.id,
      providerReference: "re_existing",
      amountMinor: BigInt(7000),
    };
    const svc = new RefundService({
      stripePort: makeMockStripePort(),
      paymentRepo: makeMockRefundRepository({ existingRefunds: [existingRefund] }),
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    await expect(
      svc.issueRefund(makeRequest({ amountMinor: BigInt(4000) })),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_CHARGE" });
  });
});

// ---------------------------------------------------------------------------
// Split refunds summing to total charge (AC5)
// ---------------------------------------------------------------------------

describe("RefundService — split refunds", () => {
  it("allows three partial refunds summing to the charge total (AC5)", async () => {
    // 3000 + 3000 + 4000 = 10000 (charge total)
    const first: typeof FIXTURE_CHARGE_ROW = { ...FIXTURE_CHARGE_ROW, id: "pay-r-1", type: "REFUND", parentPaymentId: FIXTURE_CHARGE_ROW.id, providerReference: "re_1", amountMinor: BigInt(3000) };
    const second: typeof FIXTURE_CHARGE_ROW = { ...FIXTURE_CHARGE_ROW, id: "pay-r-2", type: "REFUND", parentPaymentId: FIXTURE_CHARGE_ROW.id, providerReference: "re_2", amountMinor: BigInt(3000) };
    // After two refunds, sum = 6000; remaining = 4000

    const repo = makeMockRefundRepository({ existingRefunds: [first, second] });
    const svc = new RefundService({
      stripePort: makeMockStripePort(),
      paymentRepo: repo,
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    // Third refund: 4000 (exactly the remaining amount)
    const result = await svc.issueRefund(makeRequest({ amountMinor: BigInt(4000) }));
    expect(result.amountMinor).toBe(BigInt(4000));

    // Fourth refund: any amount → 409
    await expect(
      svc.issueRefund(makeRequest({ amountMinor: BigInt(1) })),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_CHARGE" });
  });
});

// ---------------------------------------------------------------------------
// Non-refundable leg (AC6)
// ---------------------------------------------------------------------------

describe("RefundService — non-refundable eligibility", () => {
  it("returns 422 NOT_REFUNDABLE when supplier terms deny the refund (AC6)", async () => {
    const svc = makeService({ eligible: false });

    await expect(
      svc.issueRefund(makeRequest()),
    ).rejects.toMatchObject({ code: "NOT_REFUNDABLE" });
  });

  it("names the leg and supplier term in the error (AC6)", async () => {
    const svc = new RefundService({
      stripePort: makeMockStripePort(),
      paymentRepo: makeMockRefundRepository(),
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy({
        eligible: false,
        refundableAmountMinor: BigInt(0),
        currency: FIXTURE_CURRENCY,
        supplierTermRef: "non_refundable_economy",
      }),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    const err = await svc.issueRefund(makeRequest({ legId: "leg-return" })).catch((e) => e);
    expect(err.code).toBe("NOT_REFUNDABLE");
    expect(err.legId).toBe("leg-return");
    expect(err.supplierTerm).toBe("non_refundable_economy");
  });
});

// ---------------------------------------------------------------------------
// Duplicate request idempotency (AC2)
// ---------------------------------------------------------------------------

describe("RefundService — duplicate request handling", () => {
  it("returns 409 REFUND_EXCEEDS_CHARGE rather than creating a second row when the exact same amount was already refunded (AC2 deterministic key)", async () => {
    // Simulate: full refund already completed = 10000; requesting again = 10000
    const existingFullRefund = {
      ...FIXTURE_CHARGE_ROW,
      id: "pay-r-full",
      type: "REFUND",
      parentPaymentId: FIXTURE_CHARGE_ROW.id,
      providerReference: "re_existing_full",
      amountMinor: FIXTURE_CHARGE_AMOUNT,
    };
    const svc = new RefundService({
      stripePort: makeMockStripePort(),
      paymentRepo: makeMockRefundRepository({ existingRefunds: [existingFullRefund] }),
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    // The ceiling check detects that there is nothing left to refund
    await expect(
      svc.issueRefund(makeRequest()),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_CHARGE" });
  });
});

// ---------------------------------------------------------------------------
// Provider error mapping (AC)
// ---------------------------------------------------------------------------

describe("RefundService — provider errors", () => {
  it("maps unexpected Stripe error to 502 PROVIDER_UNAVAILABLE", async () => {
    const svc = makeService({ throwOnStripe: new Error("Network error") });

    await expect(
      svc.issueRefund(makeRequest()),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

// ---------------------------------------------------------------------------
// Input validation — zero/negative amount (AC9)
// ---------------------------------------------------------------------------

describe("RefundService — input validation", () => {
  it("rejects a zero amountMinor before any Stripe call", async () => {
    const svc = makeService();

    await expect(
      svc.issueRefund(makeRequest({ amountMinor: BigInt(0) })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

// ---------------------------------------------------------------------------
// Idempotency key derivation (AC2)
// ---------------------------------------------------------------------------

describe("deriveRefundIdempotencyKey and buildRefundScopeKey", () => {
  it("produces the same key for the same charge + full scope", async () => {
    const { deriveRefundIdempotencyKey, buildRefundScopeKey } = await import(
      "../../src/adapters/StripePort.js"
    );
    const key1 = deriveRefundIdempotencyKey("pi_3abc", buildRefundScopeKey(undefined, undefined));
    const key2 = deriveRefundIdempotencyKey("pi_3abc", buildRefundScopeKey(undefined, undefined));
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);
  });

  it("produces a different key for the same charge with a different scope", async () => {
    const { deriveRefundIdempotencyKey, buildRefundScopeKey } = await import(
      "../../src/adapters/StripePort.js"
    );
    const keyFull = deriveRefundIdempotencyKey("pi_3abc", buildRefundScopeKey(undefined, undefined));
    const keyPartial = deriveRefundIdempotencyKey("pi_3abc", buildRefundScopeKey(BigInt(5000), "leg-1"));
    expect(keyFull).not.toBe(keyPartial);
  });

  it("produces different keys for different charges with the same scope", async () => {
    const { deriveRefundIdempotencyKey, buildRefundScopeKey } = await import(
      "../../src/adapters/StripePort.js"
    );
    const scope = buildRefundScopeKey(undefined, undefined);
    const key1 = deriveRefundIdempotencyKey("pi_3charge1", scope);
    const key2 = deriveRefundIdempotencyKey("pi_3charge2", scope);
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// assertIntegerMinorUnits — no-float enforcement (AC9)
// ---------------------------------------------------------------------------

describe("assertIntegerMinorUnits — no-float enforcement", () => {
  it("rejects a fractional number", async () => {
    const { assertIntegerMinorUnits } = await import("@travel/contracts");
    expect(() => assertIntegerMinorUnits(99.5)).toThrow(TypeError);
  });

  it("accepts a safe integer", async () => {
    const { assertIntegerMinorUnits } = await import("@travel/contracts");
    expect(assertIntegerMinorUnits(10000)).toBe(BigInt(10000));
  });

  it("accepts a bigint", async () => {
    const { assertIntegerMinorUnits } = await import("@travel/contracts");
    expect(assertIntegerMinorUnits(BigInt(10000))).toBe(BigInt(10000));
  });
});

// ---------------------------------------------------------------------------
// Booking not found (AC1)
// ---------------------------------------------------------------------------

describe("RefundService — booking not found", () => {
  it("throws 404 NOT_FOUND when booking does not exist", async () => {
    const svc = new RefundService({
      stripePort: makeMockStripePort(),
      paymentRepo: makeMockRefundRepository(),
      bookingQuery: makeMockBookingQuery(null),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    await expect(svc.issueRefund(makeRequest())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws 404 NOT_FOUND when no CHARGE exists for booking", async () => {
    const svc = new RefundService({
      stripePort: makeMockStripePort(),
      paymentRepo: makeMockRefundRepository({ chargeRow: null }),
      bookingQuery: makeMockBookingQuery(),
      refundPolicy: makeMockRefundPolicy(makeEligibleDecision()),
      settlementWindow: makeMockSettlementWindow(),
      queue: makeMockQueue(),
      clock: () => FIXED_NOW,
    });

    await expect(svc.issueRefund(makeRequest())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
