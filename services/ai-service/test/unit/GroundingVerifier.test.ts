/**
 * GroundingVerifier unit tests (WO-060).
 */

import { describe, it, expect } from "vitest";
import { GroundingVerifier } from "../../src/domain/grounding/GroundingVerifier.js";
import { ClaimExtractor } from "../../src/domain/grounding/ClaimExtractor.js";
import {
  makeFlightLedger,
  makeStaleLedger,
  makeHotelLedger,
  makeEmptyLedger,
  NOW_MS,
  FRESHNESS_MS,
} from "../fixtures/grounding-fixtures.js";

const extractor = new ClaimExtractor();

function verifyText(text: string, ledger: ReturnType<typeof makeFlightLedger>, now = NOW_MS) {
  const verifier = new GroundingVerifier(FRESHNESS_MS, () => now);
  const claims = extractor.extract(text);
  return verifier.verify(claims, ledger);
}

// ---------------------------------------------------------------------------
// PRICE verification
// ---------------------------------------------------------------------------

describe("GroundingVerifier — PRICE", () => {
  it("supports an exact price match", () => {
    const results = verifyText("The fare is $412.50 USD.", makeFlightLedger());
    const price = results.find((r) => r.claim.type === "PRICE");
    expect(price?.supported).toBe(true);
    expect(price?.offerRef).toBe("flight-001");
    expect(price?.stale).toBe(false);
  });

  it("rejects a price off by one cent", () => {
    const results = verifyText("The fare is $412.51 USD.", makeFlightLedger());
    const price = results.find((r) => r.claim.type === "PRICE");
    expect(price?.supported).toBe(false);
  });

  it("rejects a currency mismatch (model says USD, ledger has EUR)", () => {
    // Hotel is EUR 189; asking for $189 should be unsupported
    const results = verifyText("The room costs $189 USD.", makeHotelLedger());
    const price = results.find((r) => r.claim.type === "PRICE");
    expect(price?.supported).toBe(false);
  });

  it("marks matched price stale when offer is past freshness window", () => {
    const results = verifyText("The fare is $412.50 USD.", makeStaleLedger());
    const price = results.find((r) => r.claim.type === "PRICE");
    expect(price?.supported).toBe(true);
    expect(price?.stale).toBe(true);
  });

  it("returns unsupported when ledger is empty", () => {
    const results = verifyText("The fare is $412.50 USD.", makeEmptyLedger());
    const price = results.find((r) => r.claim.type === "PRICE");
    expect(price?.supported).toBe(false);
  });

  it("matches second offer when first does not match", () => {
    // flight-002 is $389.00 USD
    const results = verifyText("The fare is $389.00 USD.", makeFlightLedger());
    const price = results.find((r) => r.claim.type === "PRICE");
    expect(price?.supported).toBe(true);
    expect(price?.offerRef).toBe("flight-002");
  });
});

// ---------------------------------------------------------------------------
// ROUTE verification
// ---------------------------------------------------------------------------

describe("GroundingVerifier — ROUTE", () => {
  it("supports a matching route", () => {
    const results = verifyText("Fly from LHR to JFK.", makeFlightLedger());
    const route = results.find((r) => r.claim.type === "ROUTE");
    expect(route?.supported).toBe(true);
  });

  it("supports reverse route (JFK to LHR matches LHR-JFK)", () => {
    const results = verifyText("Return from JFK to LHR.", makeFlightLedger());
    const route = results.find((r) => r.claim.type === "ROUTE");
    expect(route?.supported).toBe(true);
  });

  it("rejects a fabricated route not in ledger", () => {
    const results = verifyText("Fly from JFK to CDG.", makeFlightLedger());
    const route = results.find((r) => r.claim.type === "ROUTE");
    expect(route?.supported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AVAILABILITY verification
// ---------------------------------------------------------------------------

describe("GroundingVerifier — AVAILABILITY", () => {
  it("supports availability when fresh offer exists", () => {
    const results = verifyText("Seats are available.", makeFlightLedger());
    const avail = results.find((r) => r.claim.type === "AVAILABILITY");
    expect(avail?.supported).toBe(true);
    expect(avail?.stale).toBe(false);
  });

  it("marks availability stale when all offers are past freshness", () => {
    const results = verifyText("Seats are available.", makeStaleLedger());
    const avail = results.find((r) => r.claim.type === "AVAILABILITY");
    expect(avail?.supported).toBe(true);
    expect(avail?.stale).toBe(true);
  });

  it("rejects availability when ledger is empty", () => {
    const results = verifyText("Seats are available.", makeEmptyLedger());
    const avail = results.find((r) => r.claim.type === "AVAILABILITY");
    expect(avail?.supported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty claims
// ---------------------------------------------------------------------------

describe("GroundingVerifier — no claims", () => {
  it("returns empty array for text with no factual claims", () => {
    const verifier = new GroundingVerifier(FRESHNESS_MS, () => NOW_MS);
    const claims = extractor.extract("What dates are you looking to travel?");
    const results = verifier.verify(claims, makeFlightLedger());
    expect(results).toHaveLength(0);
  });
});
