/**
 * ProvenanceLedger unit tests (WO-060).
 */

import { describe, it, expect } from "vitest";
import { ProvenanceLedger, normaliseRoute } from "../../src/domain/grounding/ProvenanceLedger.js";
import {
  FLIGHT_TOOL_RESPONSE,
  HOTEL_TOOL_RESPONSE,
  EMPTY_TOOL_RESPONSE,
  NOW_MS,
} from "../fixtures/grounding-fixtures.js";

describe("ProvenanceLedger.record", () => {
  it("records array of offers from a tool result", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", FLIGHT_TOOL_RESPONSE, NOW_MS);
    expect(ledger.size).toBe(2);
  });

  it("records a single offer object (non-array result)", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("get_offer", { id: "offer-x", provenance: "AMADEUS", price: 100, currency: "USD", bookable: true }, NOW_MS);
    expect(ledger.size).toBe(1);
  });

  it("stores correct snapshot fields", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", FLIGHT_TOOL_RESPONSE, NOW_MS);
    const snap = ledger.get("flight-001");
    expect(snap).toBeDefined();
    expect(snap!.offerRef).toBe("flight-001");
    expect(snap!.tool).toBe("search_flights");
    expect(snap!.supplier).toBe("AMADEUS");
    expect(snap!.price).toBe(412.5);
    expect(snap!.currency).toBe("USD");
    expect(snap!.availability).toBe(true);
    expect(snap!.retrievedAt).toBe(NOW_MS);
  });

  it("normalises route from from/to fields", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", FLIGHT_TOOL_RESPONSE, NOW_MS);
    const snap = ledger.get("flight-001");
    expect(snap!.route).toBe("LHR-JFK");
  });

  it("records hotel with property field", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_hotels", HOTEL_TOOL_RESPONSE, NOW_MS);
    const snap = ledger.get("hotel-001");
    expect(snap!.property).toBe("Marriott Paris");
    expect(snap!.currency).toBe("EUR");
    expect(snap!.price).toBe(189);
  });

  it("silently skips offers with missing id", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", [{ price: 100, currency: "USD" }], NOW_MS);
    expect(ledger.size).toBe(0);
  });

  it("silently skips offers with unparseable price", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", [{ id: "x", price: "not-a-number", currency: "USD" }], NOW_MS);
    expect(ledger.size).toBe(0);
  });

  it("handles empty array result gracefully", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", EMPTY_TOOL_RESPONSE, NOW_MS);
    expect(ledger.size).toBe(0);
    expect(ledger.isEmpty).toBe(true);
  });
});

describe("ProvenanceLedger.get", () => {
  it("returns undefined for unknown offerRef", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", FLIGHT_TOOL_RESPONSE, NOW_MS);
    expect(ledger.get("fabricated-ref")).toBeUndefined();
  });
});

describe("ProvenanceLedger.getAll", () => {
  it("returns all entries in insertion order", () => {
    const ledger = new ProvenanceLedger();
    ledger.record("search_flights", FLIGHT_TOOL_RESPONSE, NOW_MS);
    const all = ledger.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].offerRef).toBe("flight-001");
    expect(all[1].offerRef).toBe("flight-002");
  });
});

describe("normaliseRoute", () => {
  it("normalises arrow separator", () => {
    expect(normaliseRoute("LHR → JFK")).toBe("LHR-JFK");
  });

  it("normalises 'to' separator", () => {
    expect(normaliseRoute("lhr to jfk")).toBe("LHR-JFK");
  });

  it("normalises dash separator", () => {
    expect(normaliseRoute("LHR-JFK")).toBe("LHR-JFK");
  });

  it("uppercases all codes", () => {
    expect(normaliseRoute("lhr-jfk")).toBe("LHR-JFK");
  });
});
