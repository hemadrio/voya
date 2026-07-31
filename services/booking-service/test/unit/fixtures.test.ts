/**
 * Smoke test that imports @travel/fixtures and asserts the illustrative-offer
 * scenario used by the booking-service provenance guard.
 *
 * This file also satisfies the WO-092 criterion that every service must
 * consume the fixtures package in at least one test so the suite runs with
 * no supplier, payment provider, or AI provider network calls.
 */

import { describe, it, expect } from "vitest";
import {
  SYNTHETIC_ILLUSTRATIVE_OFFER,
  SYNTHETIC_FLIGHT_OFFER,
  SEED_IDS,
  makeBooking,
} from "@travel/fixtures";

describe("booking-service fixtures smoke test", () => {
  it("SYNTHETIC_ILLUSTRATIVE_OFFER has bookable=false and provenance=ILLUSTRATIVE", () => {
    expect(SYNTHETIC_ILLUSTRATIVE_OFFER.bookable).toBe(false);
    expect(SYNTHETIC_ILLUSTRATIVE_OFFER.provenance).toBe("ILLUSTRATIVE");
  });

  it("SYNTHETIC_FLIGHT_OFFER is bookable with AMADEUS provenance", () => {
    expect(SYNTHETIC_FLIGHT_OFFER.bookable).toBe(true);
    expect(SYNTHETIC_FLIGHT_OFFER.provenance).toBe("AMADEUS");
  });

  it("makeBooking() default is a CONFIRMED FLIGHT for Alice", () => {
    const b = makeBooking();
    expect(b.status).toBe("CONFIRMED");
    expect(b.bookingType).toBe("FLIGHT");
    expect(b.userId).toBe(SEED_IDS.user.alice);
  });

  it("makeBooking() override changes status without affecting other fields", () => {
    const b = makeBooking({ status: "CANCELLED" });
    expect(b.status).toBe("CANCELLED");
    expect(b.userId).toBe(SEED_IDS.user.alice);
    expect(b.bookingType).toBe("FLIGHT");
  });
});
