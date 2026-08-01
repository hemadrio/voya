/**
 * Unit tests for PriceRevalidationService (WO-042).
 *
 * All collaborators are in-memory doubles — no Prisma, no network.
 * Covers AC1–AC8:
 *   AC2  — unchanged price marks booking payable immediately
 *   AC3  — changed price returns priceChanged=true; booking NOT payable
 *   AC4  — assertPayable blocks when no revalidation or window expired
 *   AC5  — acceptPrice writes consent + PRICE_ACCEPTED audit atomically
 *   AC6  — supplier timeout → 504, unavailable → 502, rejected → 422
 *   AC7  — consent mismatch → 409 PRICE_CONSENT_REQUIRED
 *   AC8  — open circuit breaker → 502
 *   AC9  — unit tests: unchanged, increased, decreased, timeout,
 *           supplier rejection, open breaker, consent-mismatch
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PriceRevalidationService,
  isPriceConsentRequired,
  QUOTE_VALIDITY_MS,
  type SupplierRepricePort,
  type RevalidationRepositoryPort,
  type RevalidationBookingRow,
  type ConsentRecord,
  type RepriceOutcome,
} from "../../src/domain/PriceRevalidationService.js";
import type { AuditTxClient } from "../../src/domain/AuditWriter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOOKING_ID = "bk_revalidation_test_001";
const ACTOR = { id: "usr_traveler_01", role: "traveler" };
const FIXED_NOW = new Date("2026-08-01T12:00:00Z");

function makeBookingRow(overrides: Partial<RevalidationBookingRow> = {}): RevalidationBookingRow {
  return {
    id: BOOKING_ID,
    status: "PENDING",
    totalPrice: "412.50",
    currency: "USD",
    offerSnapshot: {
      offerId: "off_amadeus_LHR_JFK",
      supplier: "AMADEUS",
      totalPrice: "412.50",
      currency: "USD",
      bookable: true,
      legs: [
        { offerId: "off_amadeus_LHR_JFK", supplier: "AMADEUS" },
      ],
    },
    revalidatedSnapshot: null,
    payableUntil: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory repository double
// ---------------------------------------------------------------------------

class InMemoryRevalidationRepo implements RevalidationRepositoryPort {
  private bookings = new Map<string, RevalidationBookingRow>();
  consents: ConsentRecord[] = [];
  auditCreateFn = vi.fn().mockResolvedValue(undefined);

  seed(row: RevalidationBookingRow): this {
    this.bookings.set(row.id, { ...row });
    return this;
  }

  getBooking(id: string): RevalidationBookingRow | undefined {
    return this.bookings.get(id);
  }

  async findBookingForRevalidation(bookingId: string): Promise<RevalidationBookingRow | null> {
    return this.bookings.get(bookingId) ?? null;
  }

  async saveRevalidationResult(
    bookingId: string,
    revalidatedSnapshot: Record<string, unknown>,
    payableUntil: Date,
  ): Promise<void> {
    const booking = this.bookings.get(bookingId);
    if (booking) {
      booking.revalidatedSnapshot = revalidatedSnapshot;
      booking.payableUntil = payableUntil.getTime() > 0 ? payableUntil : null;
    }
  }

  async saveConsentAndMarkPayable(
    consent: ConsentRecord,
    revalidatedSnapshot: Record<string, unknown>,
    payableUntil: Date,
    _tx: AuditTxClient,
  ): Promise<void> {
    this.consents.push(consent);
    const booking = this.bookings.get(consent.bookingId);
    if (booking) {
      booking.revalidatedSnapshot = revalidatedSnapshot;
      booking.payableUntil = payableUntil;
    }
  }

  async runInTransaction<T>(work: (tx: AuditTxClient) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.bookings);
    const savedConsents = [...this.consents];
    const tx: AuditTxClient = {
      bookingAuditLog: { create: this.auditCreateFn },
    };
    try {
      return await work(tx);
    } catch (err) {
      this.bookings.clear();
      for (const [k, v] of snapshot) this.bookings.set(k, { ...v });
      this.consents.length = 0;
      this.consents.push(...savedConsents);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Supplier port helpers
// ---------------------------------------------------------------------------

function makeSupplier(price: number, freshness: "LIVE" | "CACHED" | "STALE" = "LIVE"): SupplierRepricePort {
  return {
    repriceOffer: vi.fn().mockResolvedValue({
      offerId: "off_amadeus_LHR_JFK",
      supplier: "AMADEUS",
      price,
      currency: "USD",
      freshness,
    } satisfies RepriceOutcome),
  };
}

function makeService(
  supplier: SupplierRepricePort,
  repo: InMemoryRevalidationRepo,
  overrides: { timeoutMs?: number } = {},
): PriceRevalidationService {
  return new PriceRevalidationService({
    supplierPort: supplier,
    repository: repo,
    clock: () => FIXED_NOW,
    timeoutMs: overrides.timeoutMs ?? 1_500,
  });
}

// ---------------------------------------------------------------------------
// AC2: Unchanged price — marks booking payable immediately
// ---------------------------------------------------------------------------

describe("PriceRevalidationService — unchanged price (AC2)", () => {
  it("returns priceChanged=false when supplier returns the same total", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(412.50), repo);
    const result = await svc.revalidate(BOOKING_ID, ACTOR);
    expect(result.priceChanged).toBe(false);
    expect(result.previousTotal).toBe(412.50);
    expect(result.newTotal).toBe(412.50);
    expect(result.delta).toBe(0);
  });

  it("sets payableUntil on the booking when price unchanged", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(412.50), repo);
    await svc.revalidate(BOOKING_ID, ACTOR);
    const booking = repo.getBooking(BOOKING_ID);
    expect(booking?.payableUntil).toBeInstanceOf(Date);
    expect(booking?.payableUntil?.getTime()).toBe(FIXED_NOW.getTime() + QUOTE_VALIDITY_MS);
  });

  it("stores the revalidated snapshot when price unchanged", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(412.50), repo);
    await svc.revalidate(BOOKING_ID, ACTOR);
    const booking = repo.getBooking(BOOKING_ID);
    expect(booking?.revalidatedSnapshot).not.toBeNull();
    expect((booking?.revalidatedSnapshot as Record<string, unknown>)?.totalPrice).toBe("412.50");
  });
});

// ---------------------------------------------------------------------------
// AC3: Price increased — booking NOT payable until accept-price
// ---------------------------------------------------------------------------

describe("PriceRevalidationService — price increased (AC3)", () => {
  it("returns priceChanged=true with correct delta", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(450.00), repo);
    const result = await svc.revalidate(BOOKING_ID, ACTOR);
    expect(result.priceChanged).toBe(true);
    expect(result.newTotal).toBe(450.00);
    expect(result.delta).toBeCloseTo(37.50, 5);
  });

  it("does NOT mark booking payable when price increased", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(450.00), repo);
    await svc.revalidate(BOOKING_ID, ACTOR);
    const booking = repo.getBooking(BOOKING_ID);
    expect(booking?.payableUntil).toBeNull();
  });

  it("returns quoteExpiresAt for the traveler to act before", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(450.00), repo);
    const result = await svc.revalidate(BOOKING_ID, ACTOR);
    expect(result.quoteExpiresAt.getTime()).toBe(FIXED_NOW.getTime() + QUOTE_VALIDITY_MS);
  });
});

// ---------------------------------------------------------------------------
// Price decreased — still requires consent (edge case from WO-042 spec)
// ---------------------------------------------------------------------------

describe("PriceRevalidationService — price decreased", () => {
  it("marks priceChanged=true for a lower price (consent still required)", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(380.00), repo);
    const result = await svc.revalidate(BOOKING_ID, ACTOR);
    expect(result.priceChanged).toBe(true);
    expect(result.delta).toBeCloseTo(-32.50, 5);
    const booking = repo.getBooking(BOOKING_ID);
    expect(booking?.payableUntil).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4 / AC7: assertPayable — payment precondition gate
// ---------------------------------------------------------------------------

describe("PriceRevalidationService — assertPayable (AC4)", () => {
  it("throws PRICE_CONSENT_REQUIRED when payableUntil is null", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(412.50), repo);
    const err = await svc.assertPayable(BOOKING_ID).catch((e) => e);
    expect((err as { code: string }).code).toBe("PRICE_CONSENT_REQUIRED");
    expect(isPriceConsentRequired(err)).toBe(true);
  });

  it("throws PRICE_CONSENT_REQUIRED when payableUntil is in the past", async () => {
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({ payableUntil: new Date("2020-01-01T00:00:00Z") }),
    );
    const svc = makeService(makeSupplier(412.50), repo);
    const err = await svc.assertPayable(BOOKING_ID).catch((e) => e);
    expect((err as { code: string }).code).toBe("PRICE_CONSENT_REQUIRED");
  });

  it("does not throw when payableUntil is in the future", async () => {
    const futureDate = new Date(FIXED_NOW.getTime() + 60_000);
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({ payableUntil: futureDate }),
    );
    const svc = makeService(makeSupplier(412.50), repo);
    await expect(svc.assertPayable(BOOKING_ID)).resolves.toBeUndefined();
  });

  it("throws NOT_FOUND for a missing booking", async () => {
    const repo = new InMemoryRevalidationRepo();
    const svc = makeService(makeSupplier(412.50), repo);
    const err = await svc.assertPayable("missing_id").catch((e) => e);
    expect((err as { code: string }).code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// AC5: acceptPrice — consent record + audit row written atomically
// ---------------------------------------------------------------------------

describe("PriceRevalidationService — acceptPrice (AC5)", () => {
  function makeRevalidatedSnapshot(total: string): Record<string, unknown> {
    return {
      offerId: "off_amadeus_LHR_JFK",
      supplier: "AMADEUS",
      totalPrice: total,
      currency: "USD",
      bookable: true,
      revalidatedAt: FIXED_NOW.toISOString(),
      legs: [{ offerId: "off_amadeus_LHR_JFK", supplier: "AMADEUS", price: total, currency: "USD", freshness: "LIVE" }],
    };
  }

  it("records consent and marks booking payable when total matches", async () => {
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({ revalidatedSnapshot: makeRevalidatedSnapshot("450.00") }),
    );
    const svc = makeService(makeSupplier(450.00), repo);
    const result = await svc.acceptPrice(BOOKING_ID, 450.00, "USD", ACTOR);
    expect(result.payableUntil.getTime()).toBe(FIXED_NOW.getTime() + QUOTE_VALIDITY_MS);
    expect(repo.consents).toHaveLength(1);
    expect(repo.consents[0]?.acceptedTotal).toBe("450.00");
  });

  it("writes a PRICE_ACCEPTED audit row", async () => {
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({ revalidatedSnapshot: makeRevalidatedSnapshot("450.00") }),
    );
    const svc = makeService(makeSupplier(450.00), repo);
    await svc.acceptPrice(BOOKING_ID, 450.00, "USD", ACTOR);
    expect(repo.auditCreateFn).toHaveBeenCalledOnce();
    const [createArg] = repo.auditCreateFn.mock.calls[0] as [{ data: { action: string } }];
    expect(createArg.data.action).toBe("PRICE_ACCEPTED");
  });

  it("throws PRICE_CONSENT_REQUIRED when acceptedTotal mismatches quoted total", async () => {
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({ revalidatedSnapshot: makeRevalidatedSnapshot("450.00") }),
    );
    const svc = makeService(makeSupplier(450.00), repo);
    const err = await svc.acceptPrice(BOOKING_ID, 412.50, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("PRICE_CONSENT_REQUIRED");
    expect(repo.consents).toHaveLength(0);
  });

  it("throws PRICE_CONSENT_REQUIRED when currency mismatches", async () => {
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({ revalidatedSnapshot: makeRevalidatedSnapshot("450.00") }),
    );
    const svc = makeService(makeSupplier(450.00), repo);
    const err = await svc.acceptPrice(BOOKING_ID, 450.00, "EUR", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("PRICE_CONSENT_REQUIRED");
  });

  it("throws PRICE_CONSENT_REQUIRED when booking has not been revalidated", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(450.00), repo);
    const err = await svc.acceptPrice(BOOKING_ID, 412.50, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("PRICE_CONSENT_REQUIRED");
  });

  it("throws QUOTE_EXPIRED when the revalidation is stale", async () => {
    const staleRevalidatedAt = new Date(FIXED_NOW.getTime() - QUOTE_VALIDITY_MS - 1_000).toISOString();
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({
        revalidatedSnapshot: {
          ...makeRevalidatedSnapshot("450.00"),
          revalidatedAt: staleRevalidatedAt,
        },
      }),
    );
    const svc = makeService(makeSupplier(450.00), repo);
    const err = await svc.acceptPrice(BOOKING_ID, 450.00, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("QUOTE_EXPIRED");
  });

  it("rolls back consent when audit write fails", async () => {
    const repo = new InMemoryRevalidationRepo().seed(
      makeBookingRow({ revalidatedSnapshot: makeRevalidatedSnapshot("450.00") }),
    );
    repo.auditCreateFn.mockRejectedValueOnce(new Error("DB error"));
    const svc = makeService(makeSupplier(450.00), repo);
    await svc.acceptPrice(BOOKING_ID, 450.00, "USD", ACTOR).catch(() => {});
    expect(repo.consents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC6: Supplier errors — timeout, unavailable, rejected, open breaker
// ---------------------------------------------------------------------------

describe("PriceRevalidationService — supplier errors (AC6)", () => {
  it("maps AbortError → SUPPLIER_TIMEOUT (504)", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const supplier: SupplierRepricePort = {
      repriceOffer: vi.fn().mockRejectedValue(abortError),
    };
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(supplier, repo);
    const err = await svc.revalidate(BOOKING_ID, ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("SUPPLIER_TIMEOUT");
  });

  it("maps generic Error → SUPPLIER_UNAVAILABLE (502)", async () => {
    const supplier: SupplierRepricePort = {
      repriceOffer: vi.fn().mockRejectedValue(new Error("network failure")),
    };
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(supplier, repo);
    const err = await svc.revalidate(BOOKING_ID, ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("SUPPLIER_UNAVAILABLE");
  });

  it("maps SOLD_OUT error → SUPPLIER_REJECTED (422)", async () => {
    const soldOutError = new Error("SOLD_OUT: inventory no longer available");
    const supplier: SupplierRepricePort = {
      repriceOffer: vi.fn().mockRejectedValue(soldOutError),
    };
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(supplier, repo);
    const err = await svc.revalidate(BOOKING_ID, ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("SUPPLIER_REJECTED");
  });

  it("maps circuit-open error → SUPPLIER_UNAVAILABLE (502)", async () => {
    const breakerError = new Error("CIRCUIT_OPEN: supplier circuit breaker is open");
    const supplier: SupplierRepricePort = {
      repriceOffer: vi.fn().mockRejectedValue(breakerError),
    };
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(supplier, repo);
    const err = await svc.revalidate(BOOKING_ID, ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("SUPPLIER_UNAVAILABLE");
  });

  it("booking remains PENDING after supplier failure", async () => {
    const supplier: SupplierRepricePort = {
      repriceOffer: vi.fn().mockRejectedValue(new Error("network failure")),
    };
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(supplier, repo);
    await svc.revalidate(BOOKING_ID, ACTOR).catch(() => {});
    const booking = repo.getBooking(BOOKING_ID);
    expect(booking?.status).toBe("PENDING");
    expect(booking?.payableUntil).toBeNull();
  });

  it("passes the supplier DomainError through unchanged", async () => {
    const { supplierRejected } = await import("@travel/contracts/errors");
    const domainErr = supplierRejected("Inventory unavailable for this leg");
    const supplier: SupplierRepricePort = {
      repriceOffer: vi.fn().mockRejectedValue(domainErr),
    };
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(supplier, repo);
    const err = await svc.revalidate(BOOKING_ID, ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("SUPPLIER_REJECTED");
    expect((err as Error).message).toBe("Inventory unavailable for this leg");
  });
});

// ---------------------------------------------------------------------------
// Booking not found
// ---------------------------------------------------------------------------

describe("PriceRevalidationService — booking not found", () => {
  it("revalidate throws NOT_FOUND for unknown booking", async () => {
    const repo = new InMemoryRevalidationRepo();
    const svc = makeService(makeSupplier(412.50), repo);
    const err = await svc.revalidate("missing_id", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("NOT_FOUND");
  });

  it("acceptPrice throws NOT_FOUND for unknown booking", async () => {
    const repo = new InMemoryRevalidationRepo();
    const svc = makeService(makeSupplier(412.50), repo);
    const err = await svc.acceptPrice("missing_id", 412.50, "USD", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// isPriceConsentRequired type-guard
// ---------------------------------------------------------------------------

describe("isPriceConsentRequired", () => {
  it("returns true for PRICE_CONSENT_REQUIRED error", async () => {
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(makeSupplier(412.50), repo);
    const err = await svc.assertPayable(BOOKING_ID).catch((e) => e);
    expect(isPriceConsentRequired(err)).toBe(true);
  });

  it("returns false for SUPPLIER_UNAVAILABLE error", async () => {
    const supplier: SupplierRepricePort = {
      repriceOffer: vi.fn().mockRejectedValue(new Error("network")),
    };
    const repo = new InMemoryRevalidationRepo().seed(makeBookingRow());
    const svc = makeService(supplier, repo);
    const err = await svc.revalidate(BOOKING_ID, ACTOR).catch((e) => e);
    expect(isPriceConsentRequired(err)).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isPriceConsentRequired(new Error("plain"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPriceConsentRequired(null)).toBe(false);
  });
});
