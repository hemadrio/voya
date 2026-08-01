/**
 * ClaimExtractor unit tests (WO-060).
 */

import { describe, it, expect } from "vitest";
import { ClaimExtractor } from "../../src/domain/grounding/ClaimExtractor.js";

const extractor = new ClaimExtractor();

describe("ClaimExtractor — PRICE", () => {
  it("extracts dollar-prefixed price", () => {
    const claims = extractor.extract("The fare is $412.50.");
    const price = claims.find((c) => c.type === "PRICE");
    expect(price).toBeDefined();
    expect(price!.normalisedValue).toBe("412.50:USD");
  });

  it("extracts currency-code prefix format (USD 412.50)", () => {
    const claims = extractor.extract("Cost: USD 412.50");
    const price = claims.find((c) => c.type === "PRICE");
    expect(price).toBeDefined();
    expect(price!.normalisedValue).toBe("412.50:USD");
  });

  it("extracts currency-code suffix format (412.50 USD)", () => {
    const claims = extractor.extract("Cost: 412.50 USD");
    const price = claims.find((c) => c.type === "PRICE");
    expect(price!.normalisedValue).toBe("412.50:USD");
  });

  it("extracts euro symbol price", () => {
    const claims = extractor.extract("Hotel costs €189.");
    const price = claims.find((c) => c.type === "PRICE");
    expect(price!.normalisedValue).toBe("189.00:EUR");
  });

  it("extracts EUR suffix", () => {
    const claims = extractor.extract("Room: 189 EUR");
    const price = claims.find((c) => c.type === "PRICE");
    expect(price!.normalisedValue).toBe("189.00:EUR");
  });

  it("returns correct raw text and span", () => {
    const text = "Price is $412.50 per person.";
    const claims = extractor.extract(text);
    const price = claims.find((c) => c.type === "PRICE")!;
    expect(text.slice(price.span.start, price.span.end)).toBe(price.rawText);
  });
});

describe("ClaimExtractor — ROUTE", () => {
  it("extracts JFK to CDG", () => {
    const claims = extractor.extract("Flying JFK to CDG tomorrow.");
    const route = claims.find((c) => c.type === "ROUTE");
    expect(route!.normalisedValue).toBe("JFK-CDG");
  });

  it("extracts LHR → JFK with arrow", () => {
    const claims = extractor.extract("Route: LHR → JFK");
    const route = claims.find((c) => c.type === "ROUTE");
    expect(route!.normalisedValue).toBe("LHR-JFK");
  });

  it("does not extract same-code pair (e.g. JFK to JFK)", () => {
    const claims = extractor.extract("From JFK to JFK (layover).");
    const route = claims.find((c) => c.type === "ROUTE");
    expect(route).toBeUndefined();
  });
});

describe("ClaimExtractor — TIME", () => {
  it("extracts 24h time", () => {
    const claims = extractor.extract("Departs at 14:45.");
    const time = claims.find((c) => c.type === "TIME");
    expect(time!.normalisedValue).toBe("14:45");
  });

  it("extracts 12h time with AM", () => {
    const claims = extractor.extract("Departs at 10:30 AM.");
    const time = claims.find((c) => c.type === "TIME");
    expect(time!.normalisedValue).toBe("10:30");
  });

  it("extracts 12h time with PM converting to 24h", () => {
    const claims = extractor.extract("Arrives at 8:15 PM.");
    const time = claims.find((c) => c.type === "TIME");
    expect(time!.normalisedValue).toBe("20:15");
  });
});

describe("ClaimExtractor — AVAILABILITY", () => {
  it("extracts 'available' keyword", () => {
    const claims = extractor.extract("Seats are available.");
    const avail = claims.find((c) => c.type === "AVAILABILITY");
    expect(avail).toBeDefined();
    expect(avail!.normalisedValue).toBe("available");
  });

  it("extracts 'confirmed' keyword", () => {
    const claims = extractor.extract("Your booking is confirmed.");
    const avail = claims.find((c) => c.type === "AVAILABILITY");
    expect(avail).toBeDefined();
  });
});

describe("ClaimExtractor — no claims", () => {
  it("returns empty array for a clarifying question", () => {
    const claims = extractor.extract("What dates are you looking to travel?");
    expect(claims).toHaveLength(0);
  });

  it("returns empty for an empty string", () => {
    const claims = extractor.extract("");
    expect(claims).toHaveLength(0);
  });
});

describe("ClaimExtractor — document order and deduplication", () => {
  it("returns claims in ascending start-offset order", () => {
    const claims = extractor.extract("The fare is $412.50 and the route is LHR to JFK.");
    for (let i = 1; i < claims.length; i++) {
      expect(claims[i].span.start).toBeGreaterThanOrEqual(claims[i - 1].span.start);
    }
  });

  it("does not return overlapping spans", () => {
    const claims = extractor.extract("$412.50 USD on the LHR → JFK route.");
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i], b = claims[j];
        const overlaps = a.span.start < b.span.end && a.span.end > b.span.start;
        expect(overlaps).toBe(false);
      }
    }
  });
});
