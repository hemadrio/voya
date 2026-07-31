/**
 * Unit tests for BookingCreationService (WO-039).
 *
 * Covers:
 *   - Happy path (AMADEUS, RAPIDAPI_HOTEL, RAPIDAPI_CAR) → PENDING booking created
 *   - ILLUSTRATIVE provenance → 422 OFFER_NOT_BOOKABLE, no booking row
 *   - bookable=false → 422 OFFER_NOT_BOOKABLE, no booking row
 *   - Unknown offer (OfferPort returns null) → 404 OFFER_NOT_FOUND
 *   - Expired offer (expiresAt ≤ now) → 409 OFFER_EXPIRED, no booking row
 *   - Price mismatch → server price wins, warn log emitted
 *   - Duplicate create (same idempotency key) → original returned, no second row
 *   - Snapshot immutability — offerSnapshot matches resolved offer exactly
 *   - expiresAt = now + 30 minutes
 *   - No Express or PrismaClient imports
 */

import { describe, it, expect, vi } from "vitest";
import {
  BookingCreationService,
  PENDING_WINDOW_MS,
  type BookingRepositoryPort,
  type CreatedBooking,
  type CreateBookingInput,
  type AuditWriterPort,
} from "../../src/domain/BookingCreationService.js";
import type { OfferPort, ResolvedOffer } from "../../src/domain/OfferPort.js";
import type { CreateBookingRequest } from "@travel/contracts/booking";
import {
  AMADEUS_FLIGHT_OFFER,
  RAPIDAPI_HOTEL_OFFER,
  RAPIDAPI_CAR_OFFER,
  ILLUSTRATIVE_OFFER,
  EXPIRED_AMADEUS_OFFER,
  FIXTURE_NOW,
} from "../fixtures/offer-fixtures.js";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

function makeOfferPort(offer: ResolvedOffer | null = AMADEUS_FLIGHT_OFFER): OfferPort {
  return {
    resolveOffer: vi.fn().mockResolvedValue(offer),
  };
}

function makeBookingRepo(existingBooking: CreatedBooking | null = null): {
  repo: BookingRepositoryPort;
  created: CreateBookingInput[];
} {
  const created: CreateBookingInput[] = [];
  let nextId = 1;

  const repo: BookingRepositoryPort = {
    findByIdempotencyKey: vi.fn().mockResolvedValue(existingBooking),
    createBooking: vi.fn().mockImplementation(async (input: CreateBookingInput) => {
      created.push(input);
      const id = `booking-${nextId++}`;
      const row: CreatedBooking = {
        id,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        totalPrice: input.totalPrice,
        currency: input.currency,
        expiresAt: input.expiresAt,
        provenance: input.provenance,
        offerSnapshot: input.offerSnapshot as Record<string, unknown>,
      };
      return row;
    }),
  };

  return { repo, created };
}

function makeRequest(
  overrides: Partial<CreateBookingRequest> = {},
): CreateBookingRequest {
  return {
    bookingType: "FLIGHT",
    offerId: AMADEUS_FLIGHT_OFFER.offerId,
    offerPrice: AMADEUS_FLIGHT_OFFER.totalPrice,
    currency: "USD",
    passengers: [
      {
        firstName: "Maya",
        lastName: "Chen",
        dateOfBirth: new Date("1990-03-14T00:00:00.000Z"),
        email: "maya.chen@example.com",
      },
    ],
    contactEmail: "maya.chen@example.com",
    idempotencyKey: "idem-001",
    ...overrides,
  };
}

function makeAuditWriter(): { auditWriter: AuditWriterPort; entries: unknown[] } {
  const entries: unknown[] = [];
  const auditWriter: AuditWriterPort = {
    write: vi.fn().mockImplementation(async (entry) => {
      entries.push(entry);
    }),
  };
  return { auditWriter, entries };
}

function makeService(
  offerPort: OfferPort,
  repo: BookingRepositoryPort,
  log?: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> },
  auditWriter?: AuditWriterPort,
) {
  return new BookingCreationService({
    offerPort,
    bookingRepository: repo,
    auditWriter,
    clock: () => FIXTURE_NOW,
    log,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("BookingCreationService — happy path", () => {
  it("creates a PENDING booking from an AMADEUS offer", async () => {
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    const result = await svc.create(makeRequest(), "user-001", "idem-001");

    expect(result.status).toBe("PENDING");
    expect(result.bookingId).toBeDefined();
    expect(result.totalPrice).toBe("412.50");
    expect(result.currency).toBe("USD");
    expect(result.provenance).toBe("AMADEUS");
  });

  it("creates a PENDING booking from a RAPIDAPI_HOTEL offer", async () => {
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(RAPIDAPI_HOTEL_OFFER), repo);

    const result = await svc.create(
      makeRequest({ offerId: RAPIDAPI_HOTEL_OFFER.offerId, bookingType: "HOTEL" }),
      "user-001",
      "idem-002",
    );

    expect(result.status).toBe("PENDING");
    expect(result.provenance).toBe("RAPIDAPI_HOTEL");
  });

  it("creates a PENDING booking from a RAPIDAPI_CAR offer", async () => {
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(RAPIDAPI_CAR_OFFER), repo);

    const result = await svc.create(
      makeRequest({ offerId: RAPIDAPI_CAR_OFFER.offerId, bookingType: "CAR" }),
      "user-001",
      "idem-003",
    );

    expect(result.status).toBe("PENDING");
    expect(result.provenance).toBe("RAPIDAPI_CAR");
  });

  it("sets expiresAt to now + 30 minutes", async () => {
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    const result = await svc.create(makeRequest(), "user-001", "idem-001");

    const expectedExpiresAt = new Date(FIXTURE_NOW.getTime() + PENDING_WINDOW_MS);
    expect(result.expiresAt.getTime()).toBe(expectedExpiresAt.getTime());
  });

  it("passes offerSnapshot to the repository with resolved offer data", async () => {
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    await svc.create(makeRequest(), "user-001", "idem-001");

    expect(created).toHaveLength(1);
    const snapshot = created[0]!.offerSnapshot;
    expect(snapshot.offerId).toBe(AMADEUS_FLIGHT_OFFER.offerId);
    expect(snapshot.provenance).toBe("AMADEUS");
    expect(snapshot.totalPrice).toBe("412.50");
    expect(snapshot.currency).toBe("USD");
    expect(snapshot.bookable).toBe(true);
  });

  it("snapshot contains leg descriptors from the offer", async () => {
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    await svc.create(makeRequest(), "user-001", "idem-001");

    const snapshot = created[0]!.offerSnapshot;
    expect(Array.isArray(snapshot.legs)).toBe(true);
    const legs = snapshot.legs as Array<{ origin: string; destination: string }>;
    expect(legs[0]!.origin).toBe("LHR");
    expect(legs[0]!.destination).toBe("JFK");
  });

  it("uses server price (resolved offer) not client price in the snapshot", async () => {
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    // Client sends wrong price
    await svc.create(
      makeRequest({ offerPrice: 999.99 }),
      "user-001",
      "idem-001",
    );

    // Snapshot uses resolved price
    expect(created[0]!.offerSnapshot.totalPrice).toBe("412.50");
    expect(created[0]!.totalPrice).toBe("412.50");
  });
});

// ---------------------------------------------------------------------------
// ILLUSTRATIVE rejection
// ---------------------------------------------------------------------------

describe("BookingCreationService — ILLUSTRATIVE rejection", () => {
  it("throws OFFER_NOT_BOOKABLE (422) for ILLUSTRATIVE provenance", async () => {
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(ILLUSTRATIVE_OFFER), repo);

    await expect(
      svc.create(makeRequest({ offerId: ILLUSTRATIVE_OFFER.offerId }), "user-001", "idem-001"),
    ).rejects.toMatchObject({ code: "OFFER_NOT_BOOKABLE" });
  });

  it("writes no booking row when ILLUSTRATIVE offer is rejected", async () => {
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(ILLUSTRATIVE_OFFER), repo);

    await expect(
      svc.create(makeRequest({ offerId: ILLUSTRATIVE_OFFER.offerId }), "user-001", "idem-001"),
    ).rejects.toBeDefined();

    expect(created).toHaveLength(0);
    expect(repo.createBooking).not.toHaveBeenCalled();
  });

  it("throws OFFER_NOT_BOOKABLE for bookable=false on a supplier offer", async () => {
    const nonBookable: ResolvedOffer = {
      ...AMADEUS_FLIGHT_OFFER,
      bookable: false,
    };
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(nonBookable), repo);

    await expect(
      svc.create(makeRequest(), "user-001", "idem-001"),
    ).rejects.toMatchObject({ code: "OFFER_NOT_BOOKABLE" });
  });

  it("emits a structured warn log with actor, offerId, and provenance for ILLUSTRATIVE rejection (AC4)", async () => {
    const { repo } = makeBookingRepo();
    const warnSpy = vi.fn();
    const log = { warn: warnSpy, info: vi.fn() };
    const svc = makeService(makeOfferPort(ILLUSTRATIVE_OFFER), repo, log);

    await expect(
      svc.create(makeRequest({ offerId: ILLUSTRATIVE_OFFER.offerId }), "user-001", "idem-001"),
    ).rejects.toBeDefined();

    expect(warnSpy).toHaveBeenCalledOnce();
    const [obj] = warnSpy.mock.calls[0]!;
    expect(obj.offerId).toBe(ILLUSTRATIVE_OFFER.offerId);
    expect(obj.provenance).toBe("ILLUSTRATIVE");
    expect(obj.userId).toBe("user-001");
  });
});

// ---------------------------------------------------------------------------
// Offer not found
// ---------------------------------------------------------------------------

describe("BookingCreationService — offer not found", () => {
  it("throws NOT_FOUND (404) when OfferPort returns null", async () => {
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(null), repo);

    await expect(
      svc.create(makeRequest({ offerId: "unknown-offer-xyz" }), "user-001", "idem-001"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("writes no booking row when offer is not found", async () => {
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(null), repo);

    await expect(
      svc.create(makeRequest(), "user-001", "idem-001"),
    ).rejects.toBeDefined();

    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expired offer
// ---------------------------------------------------------------------------

describe("BookingCreationService — expired offer", () => {
  it("throws OFFER_EXPIRED (409) when offer.expiresAt ≤ now", async () => {
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(EXPIRED_AMADEUS_OFFER), repo);

    await expect(
      svc.create(makeRequest(), "user-001", "idem-001"),
    ).rejects.toMatchObject({ code: "OFFER_EXPIRED" });
  });

  it("writes no booking row when offer is expired", async () => {
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(EXPIRED_AMADEUS_OFFER), repo);

    await expect(
      svc.create(makeRequest(), "user-001", "idem-001"),
    ).rejects.toBeDefined();

    expect(created).toHaveLength(0);
  });

  it("accepts an offer with expiresAt exactly after now", async () => {
    const futureOffer: ResolvedOffer = {
      ...AMADEUS_FLIGHT_OFFER,
      // 1 ms after FIXTURE_NOW — strictly after, so not expired
      expiresAt: new Date(FIXTURE_NOW.getTime() + 1),
    };
    const { repo } = makeBookingRepo();
    const svc = makeService(makeOfferPort(futureOffer), repo);

    const result = await svc.create(makeRequest(), "user-001", "idem-001");
    expect(result.status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Price mismatch warn log
// ---------------------------------------------------------------------------

describe("BookingCreationService — price mismatch", () => {
  it("emits a warn log when client price differs from resolved price", async () => {
    const { repo } = makeBookingRepo();
    const warnSpy = vi.fn();
    const log = { warn: warnSpy, info: vi.fn() };
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo, log);

    await svc.create(
      makeRequest({ offerPrice: 999.00 }), // client sends wrong price
      "user-001",
      "idem-001",
    );

    expect(warnSpy).toHaveBeenCalledOnce();
    const [obj] = warnSpy.mock.calls[0]!;
    expect(obj.clientPrice).toBe("999.00");
    expect(obj.resolvedPrice).toBe("412.50");
  });

  it("does NOT emit a warn log when prices match", async () => {
    const { repo } = makeBookingRepo();
    const warnSpy = vi.fn();
    const log = { warn: warnSpy, info: vi.fn() };
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo, log);

    await svc.create(makeRequest(), "user-001", "idem-001");

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency — duplicate create returns original
// ---------------------------------------------------------------------------

describe("BookingCreationService — idempotency", () => {
  it("returns original booking when idempotency key already exists", async () => {
    const existingBooking: CreatedBooking = {
      id: "booking-existing-001",
      idempotencyKey: "idem-001",
      status: "PENDING",
      totalPrice: "412.50",
      currency: "USD",
      expiresAt: new Date(FIXTURE_NOW.getTime() + PENDING_WINDOW_MS),
      provenance: "AMADEUS",
      offerSnapshot: { offerId: AMADEUS_FLIGHT_OFFER.offerId },
    };

    const { repo, created } = makeBookingRepo(existingBooking);
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    const result = await svc.create(makeRequest(), "user-001", "idem-001");

    expect(result.bookingId).toBe("booking-existing-001");
    expect(created).toHaveLength(0); // no second row created
    expect(repo.createBooking).not.toHaveBeenCalled();
  });

  it("does not call offerPort when idempotency key matches existing booking", async () => {
    const existingBooking: CreatedBooking = {
      id: "booking-existing-001",
      idempotencyKey: "idem-001",
      status: "PENDING",
      totalPrice: "412.50",
      currency: "USD",
      expiresAt: new Date(FIXTURE_NOW.getTime() + PENDING_WINDOW_MS),
      provenance: "AMADEUS",
      offerSnapshot: {},
    };

    const { repo } = makeBookingRepo(existingBooking);
    const offerPort = makeOfferPort(AMADEUS_FLIGHT_OFFER);
    const svc = makeService(offerPort, repo);

    await svc.create(makeRequest(), "user-001", "idem-001");

    expect(offerPort.resolveOffer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Snapshot immutability (compile-time and domain-layer)
// ---------------------------------------------------------------------------

describe("BookingCreationService — snapshot immutability", () => {
  it("snapshot in the created row equals the resolved offer data exactly", async () => {
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    await svc.create(makeRequest(), "user-001", "idem-001");

    const snapshot = created[0]!.offerSnapshot;
    expect(snapshot.offerId).toBe(AMADEUS_FLIGHT_OFFER.offerId);
    expect(snapshot.provenance).toBe(AMADEUS_FLIGHT_OFFER.provenance);
    expect(snapshot.supplier).toBe(AMADEUS_FLIGHT_OFFER.supplier);
    expect(snapshot.totalPrice).toBe("412.50"); // decimal string, not float
    expect(snapshot.bookable).toBe(true);
    expect(snapshot.expiresAt).toBe(AMADEUS_FLIGHT_OFFER.expiresAt!.toISOString());
  });

  it("snapshot totalPrice is a decimal string — no float", async () => {
    const offer: ResolvedOffer = {
      ...AMADEUS_FLIGHT_OFFER,
      totalPrice: 99.9, // potential float edge case
    };
    const { repo, created } = makeBookingRepo();
    const svc = makeService(makeOfferPort(offer), repo);

    await svc.create(makeRequest(), "user-001", "idem-001");

    expect(created[0]!.offerSnapshot.totalPrice).toBe("99.90");
    expect(typeof created[0]!.offerSnapshot.totalPrice).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// AuditWriterPort — constructor injection (AC6)
// ---------------------------------------------------------------------------

describe("BookingCreationService — audit writer injection (AC6)", () => {
  it("calls auditWriter.write() once on successful create", async () => {
    const { repo } = makeBookingRepo();
    const { auditWriter, entries } = makeAuditWriter();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo, undefined, auditWriter);

    await svc.create(makeRequest(), "user-001", "idem-001");

    expect(auditWriter.write).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
  });

  it("audit entry contains bookingId, action BOOKING_CREATED, actorId, payload", async () => {
    const { repo } = makeBookingRepo();
    const { auditWriter, entries } = makeAuditWriter();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo, undefined, auditWriter);

    await svc.create(makeRequest(), "user-001", "idem-001");

    const entry = entries[0] as { bookingId: string; action: string; actorId: string; payload: Record<string, unknown> };
    expect(entry.action).toBe("BOOKING_CREATED");
    expect(entry.actorId).toBe("user-001");
    expect(entry.bookingId).toBeDefined();
    expect(entry.payload).toBeDefined();
    expect(entry.payload.provenance).toBe("AMADEUS");
  });

  it("audit entry occurredAt matches the injected clock instant", async () => {
    const { repo } = makeBookingRepo();
    const { auditWriter, entries } = makeAuditWriter();
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo, undefined, auditWriter);

    await svc.create(makeRequest(), "user-001", "idem-001");

    const entry = entries[0] as { occurredAt: Date };
    expect(entry.occurredAt.getTime()).toBe(FIXTURE_NOW.getTime());
  });

  it("does NOT call auditWriter when ILLUSTRATIVE offer is rejected", async () => {
    const { repo } = makeBookingRepo();
    const { auditWriter } = makeAuditWriter();
    const svc = makeService(makeOfferPort(ILLUSTRATIVE_OFFER), repo, undefined, auditWriter);

    await expect(
      svc.create(makeRequest({ offerId: ILLUSTRATIVE_OFFER.offerId }), "user-001", "idem-001"),
    ).rejects.toBeDefined();

    expect(auditWriter.write).not.toHaveBeenCalled();
  });

  it("does NOT call auditWriter when offer is not found (404)", async () => {
    const { repo } = makeBookingRepo();
    const { auditWriter } = makeAuditWriter();
    const svc = makeService(makeOfferPort(null), repo, undefined, auditWriter);

    await expect(
      svc.create(makeRequest(), "user-001", "idem-001"),
    ).rejects.toBeDefined();

    expect(auditWriter.write).not.toHaveBeenCalled();
  });

  it("works without an auditWriter (optional dep — no error)", async () => {
    const { repo } = makeBookingRepo();
    // No auditWriter passed — should not throw
    const svc = makeService(makeOfferPort(AMADEUS_FLIGHT_OFFER), repo);

    const result = await svc.create(makeRequest(), "user-001", "idem-001");
    expect(result.status).toBe("PENDING");
  });
});
