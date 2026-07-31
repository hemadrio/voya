/**
 * Factory unit tests — determinism, override merging, and schema validation.
 *
 * Determinism checksum: we serialize the full default output of each factory
 * and assert that two consecutive calls produce an identical string. This
 * prevents accidental introduction of Date.now() or Math.random() calls.
 */

import { describe, it, expect } from "vitest";
import {
  makeUser,
  makeBooking,
  makeItinerary,
  makeBookingTraveler,
  makeAuditLog,
  makeProcessedEvent,
  makeTravelPreference,
  SEED_IDS,
  SEED_REFERENCE_INSTANT,
  SEED_BOOKINGS,
  SEED_USERS,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Factory determinism", () => {
  it("makeUser() produces identical output on two calls", () => {
    const a = makeUser();
    const b = makeUser();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("makeBooking() produces identical output on two calls", () => {
    const a = makeBooking();
    const b = makeBooking();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("makeItinerary() produces identical output on two calls", () => {
    const a = makeItinerary();
    const b = makeItinerary();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("makeProcessedEvent() produces identical output on two calls", () => {
    const a = makeProcessedEvent();
    const b = makeProcessedEvent();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Stable IDs
// ---------------------------------------------------------------------------

describe("SEED_IDS stability", () => {
  it("alice user ID is stable", () => {
    expect(SEED_IDS.user.alice).toBe("f0000000-0000-4000-8000-000000000001");
  });

  it("flightConfirmed booking ID is stable", () => {
    expect(SEED_IDS.booking.flightConfirmed).toBe("f0000002-0000-4000-8000-000000000001");
  });

  it("SEED_REFERENCE_INSTANT is the expected date", () => {
    expect(SEED_REFERENCE_INSTANT.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Override merging
// ---------------------------------------------------------------------------

describe("Override merging", () => {
  it("makeUser() applies email override", () => {
    const u = makeUser({ email: "override@synth.example" });
    expect(u.email).toBe("override@synth.example");
    // Unchanged fields
    expect(u.id).toBe(SEED_IDS.user.alice);
  });

  it("makeBooking() applies status override", () => {
    const b = makeBooking({ status: "CANCELLED" });
    expect(b.status).toBe("CANCELLED");
    expect(b.userId).toBe(SEED_IDS.user.alice);
  });

  it("makeItinerary() applies userId override", () => {
    const i = makeItinerary({ userId: SEED_IDS.user.bob });
    expect(i.userId).toBe(SEED_IDS.user.bob);
    expect(i.classification).toBe("CONFIDENTIAL");
  });
});

// ---------------------------------------------------------------------------
// Dataset completeness
// ---------------------------------------------------------------------------

describe("SEED_BOOKINGS completeness", () => {
  const statuses = SEED_BOOKINGS.map((b) => b.status);

  it("covers PENDING (active)", () => {
    expect(SEED_BOOKINGS.some((b) => b.status === "PENDING" && b.expiresAt !== null && b.expiresAt > SEED_REFERENCE_INSTANT)).toBe(true);
  });

  it("covers PENDING past expiry", () => {
    expect(SEED_BOOKINGS.some((b) => b.status === "PENDING" && b.expiresAt !== null && b.expiresAt < SEED_REFERENCE_INSTANT)).toBe(true);
  });

  it("covers CONFIRMED", () => expect(statuses).toContain("CONFIRMED"));
  it("covers CANCELLED", () => expect(statuses).toContain("CANCELLED"));
  it("covers FAILED", () => expect(statuses).toContain("FAILED"));
  it("covers REFUNDED", () => expect(statuses).toContain("REFUNDED"));
  it("covers EXPIRED", () => expect(statuses).toContain("EXPIRED"));

  it("includes an ILLUSTRATIVE (non-bookable) offer booking", () => {
    const illustrative = SEED_BOOKINGS.find((b) => b.provenance === "ILLUSTRATIVE");
    expect(illustrative).toBeDefined();
    expect(illustrative?.bookable).toBe(false);
  });

  it("covers all three booking categories (FLIGHT, HOTEL, CAR)", () => {
    const types = SEED_BOOKINGS.map((b) => b.bookingType);
    expect(types).toContain("FLIGHT");
    expect(types).toContain("HOTEL");
    expect(types).toContain("CAR");
  });
});

describe("SEED_USERS completeness", () => {
  it("has three personas", () => expect(SEED_USERS).toHaveLength(3));

  it("Charlie has erasure metadata (purge after set)", () => {
    const charlie = SEED_USERS.find((u) => u.id === SEED_IDS.user.charlie);
    expect(charlie?.erasureRequestedAt).not.toBeNull();
    expect(charlie?.purgeAfter).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retention timestamp population
// ---------------------------------------------------------------------------

describe("Retention timestamp coverage", () => {
  it("makeUser() has null purgeAfter by default (no erasure request yet)", () => {
    expect(makeUser().purgeAfter).toBeNull();
  });

  it("makeBooking() has non-null purgeAfter (CONFIDENTIAL transaction data)", () => {
    expect(makeBooking().purgeAfter).not.toBeNull();
  });

  it("makeItinerary() has non-null purgeAfter (CONFIDENTIAL)", () => {
    expect(makeItinerary().purgeAfter).not.toBeNull();
  });

  it("makeBookingTraveler() has non-null purgeAfter (RESTRICTED identity)", () => {
    expect(makeBookingTraveler().purgeAfter).not.toBeNull();
  });

  it("makeTravelPreference() has non-null purgeAfter", () => {
    expect(makeTravelPreference().purgeAfter).not.toBeNull();
  });
});
