/**
 * Unit tests for PaymentIntentService (WO-045).
 *
 * All collaborators are in-memory doubles — no Prisma, no Stripe SDK, no network.
 *
 * Covers:
 *   AC1  — precondition checks: PENDING, not expired, re-validated, price-accepted
 *   AC2  — idempotency key derived deterministically from (bookingId, amountMinor, currency)
 *   AC3  — payments row created with correct fields; unique constraint prevents duplicates
 *   AC5  — amount derived server-side from booking; mismatch logged at warn
 *   AC6  — response contains only clientSecret, amountMinor, currency, status, paymentId
 *   AC7  — repeated calls return same clientSecret, do not increment row count
 *   AC9  — unit tests: happy path, not payable, expired, missing consent, duplicate, Stripe error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PaymentIntentService,
  isPaymentDomainError,
  type BookingQueryPort,
  type PayableBookingRow,
  type PaymentActor,
} from "../../src/domain/PaymentIntentService.js";
import type { AuditTxClient } from "../../src/domain/AuditWriter.js";
import type {
  PaymentRepositoryPort,
  PaymentRow,
  CreatePaymentData,
} from "../../src/repositories/PaymentRepository.js";
import type { StripePort, StripeCreateIntentParams, StripeIntentResult } from "../../src/adapters/StripePort.js";
import { deriveIdempotencyKey } from "../../src/adapters/StripePort.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOOKING_ID = "bk_intent_test_001";
const ACTOR: PaymentActor = { id: "usr_traveler_01", role: "traveler" };
const FIXED_NOW = new Date("2026-08-01T12:00:00Z");
const FUTURE = new Date(FIXED_NOW.getTime() + 60_000);
const PAST = new Date(FIXED_NOW.getTime() - 60_000);

function makeBookingRow(overrides: Partial<PayableBookingRow> = {}): PayableBookingRow {
  return {
    id: BOOKING_ID,
    status: "PENDING",
    totalPrice: "412.50",
    currency: "USD",
    expiresAt: new Date(FIXED_NOW.getTime() + 30 * 60_000), // 30 min from now
    payableUntil: FUTURE,
    ...overrides,
  };
}

const STRIPE_INTENT_ID = "pi_test_stripe_001";
const CLIENT_SECRET = "pi_test_stripe_001_secret_xyz";

function makeStripeResult(overrides: Partial<StripeIntentResult> = {}): StripeIntentResult {
  return {
    id: STRIPE_INTENT_ID,
    clientSecret: CLIENT_SECRET,
    status: "requires_payment_method",
    amountMinor: 41250n,
    currency: "usd",
    ...overrides,
  };
}

function makePaymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "pay_row_001",
    bookingId: BOOKING_ID,
    provider: "stripe",
    providerReference: STRIPE_INTENT_ID,
    type: "CHARGE",
    parentPaymentId: null,
    amountMinor: 41250n,
    currency: "USD",
    status: "requires_payment_method",
    cardBrand: null,
    cardLast4: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory doubles
// ---------------------------------------------------------------------------

class InMemoryBookingQuery implements BookingQueryPort {
  private booking: PayableBookingRow | null = null;

  seed(row: PayableBookingRow): this {
    this.booking = { ...row };
    return this;
  }

  async findBookingForPayment(_bookingId: string): Promise<PayableBookingRow | null> {
    return this.booking;
  }
}

class InMemoryPaymentRepo implements PaymentRepositoryPort {
  rows: PaymentRow[] = [];
  auditCreateFn = vi.fn().mockResolvedValue(undefined);

  async findExistingCharge(
    bookingId: string,
    amountMinor: bigint,
    currency: string,
  ): Promise<PaymentRow | null> {
    return (
      this.rows.find(
        (r) =>
          r.bookingId === bookingId &&
          r.amountMinor === amountMinor &&
          r.currency === currency &&
          r.status !== "FAILED",
      ) ?? null
    );
  }

  async findByProviderRef(provider: string, providerReference: string): Promise<PaymentRow | null> {
    return this.rows.find((r) => r.provider === provider && r.providerReference === providerReference) ?? null;
  }

  async createPaymentInTx(data: CreatePaymentData, _tx: AuditTxClient): Promise<PaymentRow> {
    const row: PaymentRow = {
      id: `pay_row_${this.rows.length + 1}`,
      bookingId: data.bookingId,
      provider: data.provider,
      providerReference: data.providerReference,
      type: data.type,
      parentPaymentId: data.parentPaymentId ?? null,
      amountMinor: data.amountMinor,
      currency: data.currency,
      status: data.status,
      cardBrand: data.cardBrand ?? null,
      cardLast4: data.cardLast4 ?? null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.rows.push(row);
    return row;
  }

  async runInTransaction<T>(work: (tx: AuditTxClient) => Promise<T>): Promise<T> {
    const savedRows = [...this.rows];
    const tx: AuditTxClient = {
      bookingAuditLog: { create: this.auditCreateFn },
    };
    try {
      return await work(tx);
    } catch (err) {
      this.rows = savedRows;
      throw err;
    }
  }
}

class InMemoryStripePort implements StripePort {
  calls: StripeCreateIntentParams[] = [];
  private result: StripeIntentResult | Error = makeStripeResult();

  setResult(result: StripeIntentResult | Error): this {
    this.result = result;
    return this;
  }

  async createIntent(params: StripeCreateIntentParams): Promise<StripeIntentResult> {
    this.calls.push(params);
    if (this.result instanceof Error) throw this.result;
    return { ...this.result };
  }
}

function makeService(
  stripe: InMemoryStripePort,
  bookingQuery: InMemoryBookingQuery,
  repo: InMemoryPaymentRepo,
) {
  return new PaymentIntentService({
    stripePort: stripe,
    paymentRepo: repo,
    bookingQuery,
    clock: () => FIXED_NOW,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("PaymentIntentService — happy path (AC1, AC3, AC5, AC6)", () => {
  it("creates a payment row and returns clientSecret on first call", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const result = await svc.createIntent(BOOKING_ID, "USD", ACTOR);

    expect(result.clientSecret).toBe(CLIENT_SECRET);
    expect(result.amountMinor).toBe(41250n);
    expect(result.currency).toBe("USD");
    expect(result.status).toBe("REQUIRES_PAYMENT_METHOD");
    expect(result.paymentId).toBeTruthy();
  });

  it("creates exactly one payment row in the ledger", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    await svc.createIntent(BOOKING_ID, "USD", ACTOR);

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.provider).toBe("stripe");
    expect(repo.rows[0]?.type).toBe("CHARGE");
    expect(repo.rows[0]?.amountMinor).toBe(41250n);
  });

  it("writes a PAYMENT_INTENT_CREATED audit row", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    await svc.createIntent(BOOKING_ID, "USD", ACTOR, "corr-123");

    expect(repo.auditCreateFn).toHaveBeenCalledOnce();
    const [arg] = repo.auditCreateFn.mock.calls[0] as [{ data: { action: string; bookingId: string } }];
    expect(arg.data.action).toBe("PAYMENT_INTENT_CREATED");
    expect(arg.data.bookingId).toBe(BOOKING_ID);
  });

  it("derives amount server-side from booking totalPrice (AC5)", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow({ totalPrice: "250.00" }));
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const result = await svc.createIntent(BOOKING_ID, "USD", ACTOR);

    // 250.00 → 25000 minor units
    expect(result.amountMinor).toBe(25000n);
    expect(stripe.calls[0]?.amountMinor).toBe(25000n);
  });

  it("normalises currency to uppercase", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const result = await svc.createIntent(BOOKING_ID, "usd", ACTOR);
    expect(result.currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Idempotency key derivation (AC2)
// ---------------------------------------------------------------------------

describe("deriveIdempotencyKey — deterministic (AC2)", () => {
  it("produces the same 64-char hex for the same inputs", () => {
    const k1 = deriveIdempotencyKey(BOOKING_ID, 41250n, "USD");
    const k2 = deriveIdempotencyKey(BOOKING_ID, 41250n, "USD");
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(64);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different key when amount changes", () => {
    const k1 = deriveIdempotencyKey(BOOKING_ID, 41250n, "USD");
    const k2 = deriveIdempotencyKey(BOOKING_ID, 45000n, "USD");
    expect(k1).not.toBe(k2);
  });

  it("produces a different key when bookingId changes", () => {
    const k1 = deriveIdempotencyKey("bk_001", 41250n, "USD");
    const k2 = deriveIdempotencyKey("bk_002", 41250n, "USD");
    expect(k1).not.toBe(k2);
  });

  it("passes derived key to Stripe createIntent call", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    await svc.createIntent(BOOKING_ID, "USD", ACTOR);

    const expected = deriveIdempotencyKey(BOOKING_ID, 41250n, "USD");
    expect(stripe.calls[0]?.idempotencyKey).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Idempotent repeat call (AC7)
// ---------------------------------------------------------------------------

describe("PaymentIntentService — idempotent repeat call (AC7)", () => {
  it("returns same clientSecret on duplicate request without creating a second row", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const r1 = await svc.createIntent(BOOKING_ID, "USD", ACTOR);
    const r2 = await svc.createIntent(BOOKING_ID, "USD", ACTOR);

    expect(r1.clientSecret).toBe(r2.clientSecret);
    expect(r1.paymentId).toBe(r2.paymentId);
    // Only one DB row despite two calls
    expect(repo.rows).toHaveLength(1);
  });

  it("audit row only written once (first call)", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    await svc.createIntent(BOOKING_ID, "USD", ACTOR);
    await svc.createIntent(BOOKING_ID, "USD", ACTOR);

    expect(repo.auditCreateFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Precondition failures (AC1)
// ---------------------------------------------------------------------------

describe("PaymentIntentService — precondition failures (AC1)", () => {
  it("throws NOT_FOUND when booking does not exist", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery(); // no booking seeded
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent("unknown_bk", "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("NOT_FOUND");
    expect(stripe.calls).toHaveLength(0);
  });

  it("throws BOOKING_NOT_PAYABLE when booking is CONFIRMED (not PENDING)", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow({ status: "CONFIRMED" }));
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("BOOKING_NOT_PAYABLE");
    expect(stripe.calls).toHaveLength(0);
  });

  it("throws BOOKING_NOT_PAYABLE when booking is CANCELLED", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow({ status: "CANCELLED" }));
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("BOOKING_NOT_PAYABLE");
  });

  it("throws BOOKING_NOT_PAYABLE when booking expiresAt is in the past", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow({ expiresAt: PAST }));
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("BOOKING_NOT_PAYABLE");
    expect(stripe.calls).toHaveLength(0);
  });

  it("throws PRICE_CONSENT_REQUIRED when payableUntil is null", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow({ payableUntil: null }));
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("PRICE_CONSENT_REQUIRED");
    expect(stripe.calls).toHaveLength(0);
  });

  it("throws PRICE_CONSENT_REQUIRED when payableUntil has expired", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow({ payableUntil: PAST }));
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("PRICE_CONSENT_REQUIRED");
    expect(stripe.calls).toHaveLength(0);
  });

  it("throws UNSUPPORTED_CURRENCY when currency does not match booking", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow({ currency: "USD" }));
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "EUR", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("UNSUPPORTED_CURRENCY");
    expect(stripe.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stripe error mapping
// ---------------------------------------------------------------------------

describe("PaymentIntentService — Stripe error mapping", () => {
  it("re-throws DomainError from Stripe port unchanged", async () => {
    const { providerUnavailable } = await import("@travel/contracts/errors");
    const domainErr = providerUnavailable("Stripe is down");
    const stripe = new InMemoryStripePort().setResult(domainErr);
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("PROVIDER_UNAVAILABLE");
    expect((err as Error).message).toBe("Stripe is down");
    expect(repo.rows).toHaveLength(0);
  });

  it("wraps unknown Stripe errors as PROVIDER_UNAVAILABLE", async () => {
    const stripe = new InMemoryStripePort().setResult(new Error("network error"));
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    const err = await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("PROVIDER_UNAVAILABLE");
    expect(repo.rows).toHaveLength(0);
  });

  it("does not create a payment row when Stripe call fails", async () => {
    const stripe = new InMemoryStripePort().setResult(new Error("timeout"));
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    await svc.createIntent(BOOKING_ID, "USD", ACTOR).catch(() => {});
    expect(repo.rows).toHaveLength(0);
    expect(repo.auditCreateFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PCI containment — no card data in domain (AC4)
// ---------------------------------------------------------------------------

describe("PCI containment (AC4)", () => {
  it("payment row has no full card number, CVC, or expiry fields", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    await svc.createIntent(BOOKING_ID, "USD", ACTOR);

    const row = repo.rows[0]!;
    const rowKeys = Object.keys(row);
    const panShapedKeys = rowKeys.filter((k) =>
      ["pan", "cardNumber", "card_number", "cvc", "cvv", "expiry", "expiryDate"].includes(k),
    );
    expect(panShapedKeys).toHaveLength(0);
  });

  it("audit payload has no PAN-shaped value", async () => {
    const stripe = new InMemoryStripePort();
    const query = new InMemoryBookingQuery().seed(makeBookingRow());
    const repo = new InMemoryPaymentRepo();
    const svc = makeService(stripe, query, repo);

    await svc.createIntent(BOOKING_ID, "USD", ACTOR, "corr-456");

    const [arg] = repo.auditCreateFn.mock.calls[0] as [{ data: { payload: Record<string, unknown> } }];
    const payloadStr = JSON.stringify(arg.data.payload);
    // PAN pattern: 13–19 consecutive digits
    const panPattern = /\b\d{13,19}\b/;
    expect(panPattern.test(payloadStr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPaymentDomainError helper
// ---------------------------------------------------------------------------

describe("isPaymentDomainError", () => {
  it("returns true for a DomainError", async () => {
    const { notFound } = await import("@travel/contracts/errors");
    expect(isPaymentDomainError(notFound("test"))).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isPaymentDomainError(new Error("plain"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPaymentDomainError(null)).toBe(false);
  });
});
