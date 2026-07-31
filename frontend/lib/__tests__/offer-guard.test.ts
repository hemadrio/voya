import { describe, expect, it } from "vitest";
import { getBookabilityState, canInitiateCheckout, getFreshnessLabel } from "../offer-guard.js";
import type { Offer } from "@travel/contracts/search";

const FUTURE = new Date("2099-12-31T23:59:59.000Z");
const PAST = new Date("2020-01-01T00:00:00.000Z");
const NOW = new Date("2030-06-01T12:00:00.000Z");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer_test",
    provenance: "AMADEUS",
    bookable: true,
    title: "Test Flight JFK-LAX",
    price: 412.5,
    currency: "USD",
    details: {},
    expiresAt: FUTURE,
    freshness: "FRESH",
    ...overrides,
  };
}

describe("getBookabilityState — ILLUSTRATIVE offers", () => {
  it("returns bookable: false with reason ILLUSTRATIVE for provenance ILLUSTRATIVE", () => {
    const offer = makeOffer({ provenance: "ILLUSTRATIVE", bookable: false });
    const state = getBookabilityState(offer, NOW);

    expect(state.bookable).toBe(false);
    if (!state.bookable) expect(state.reason).toBe("ILLUSTRATIVE");
  });

  it("ILLUSTRATIVE overrides even if bookable flag were somehow true", () => {
    // OfferSchema prevents this combination, but the guard must be robust.
    const offer = makeOffer({ provenance: "ILLUSTRATIVE", bookable: true });
    const state = getBookabilityState(offer as Offer, NOW);

    expect(state.bookable).toBe(false);
    if (!state.bookable) expect(state.reason).toBe("ILLUSTRATIVE");
  });

  it("cannot initiate checkout for an ILLUSTRATIVE offer", () => {
    const offer = makeOffer({ provenance: "ILLUSTRATIVE", bookable: false });
    expect(canInitiateCheckout(offer, NOW)).toBe(false);
  });
});

describe("getBookabilityState — expired offers", () => {
  it("returns bookable: false with reason EXPIRED when expiresAt is in the past", () => {
    const offer = makeOffer({ expiresAt: PAST });
    const state = getBookabilityState(offer, NOW);

    expect(state.bookable).toBe(false);
    if (!state.bookable) expect(state.reason).toBe("EXPIRED");
  });

  it("returns bookable: false when expiresAt equals NOW (boundary: not strictly future)", () => {
    const offer = makeOffer({ expiresAt: NOW });
    const state = getBookabilityState(offer, NOW);

    expect(state.bookable).toBe(false);
    if (!state.bookable) expect(state.reason).toBe("EXPIRED");
  });

  it("cannot initiate checkout for an expired offer", () => {
    const offer = makeOffer({ expiresAt: PAST });
    expect(canInitiateCheckout(offer, NOW)).toBe(false);
  });
});

describe("getBookabilityState — bookable offers", () => {
  it("returns bookable: true for a fresh AMADEUS offer", () => {
    const offer = makeOffer({ provenance: "AMADEUS", bookable: true, expiresAt: FUTURE });
    const state = getBookabilityState(offer, NOW);

    expect(state.bookable).toBe(true);
  });

  it("returns bookable: true for a fresh RAPIDAPI offer", () => {
    const offer = makeOffer({ provenance: "RAPIDAPI", bookable: true, expiresAt: FUTURE });
    expect(getBookabilityState(offer, NOW).bookable).toBe(true);
  });

  it("can initiate checkout for a fresh bookable offer", () => {
    const offer = makeOffer({ expiresAt: FUTURE });
    expect(canInitiateCheckout(offer, NOW)).toBe(true);
  });
});

describe("getFreshnessLabel", () => {
  it("returns an empty string for FRESH offers", () => {
    const offer = makeOffer({ freshness: "FRESH" });
    expect(getFreshnessLabel(offer)).toBe("");
  });

  it("returns a non-empty label for STALE offers", () => {
    const offer = makeOffer({ freshness: "STALE" });
    const label = getFreshnessLabel(offer);
    expect(label.length).toBeGreaterThan(0);
  });
});
