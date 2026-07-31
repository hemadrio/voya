/**
 * Consumer-driven fixture test for the Next.js frontend.
 *
 * Asserts that every fixture still parses against the contracts schemas the
 * frontend directly consumes.  A narrowing contracts change will fail here
 * before it reaches the browser.
 *
 * Owner: frontend team.
 */
import { describe, expect, it } from "vitest";
import { OfferSchema } from "@travel/contracts/search";
import { CreateBookingRequestSchema } from "@travel/contracts/booking";
import { ErrorEnvelopeSchema } from "@travel/contracts/errors";
import searchResponse from "./fixtures/search-response.json" with { type: "json" };
import offerList from "./fixtures/offer-list.json" with { type: "json" };
import error400 from "./fixtures/errors/400.json" with { type: "json" };
import error401 from "./fixtures/errors/401.json" with { type: "json" };
import error403 from "./fixtures/errors/403.json" with { type: "json" };
import error409 from "./fixtures/errors/409.json" with { type: "json" };
import error502 from "./fixtures/errors/502.json" with { type: "json" };

type SearchResponse = { offers: unknown[] };

describe("frontend consumer — Offer", () => {
  it("all offers in search-response fixture validate against OfferSchema", () => {
    const { offers } = searchResponse as SearchResponse;
    for (const offer of offers) {
      const result = OfferSchema.safeParse(offer);
      expect(result.success).toBe(true);
    }
  });

  it("ILLUSTRATIVE offer in offer-list fixture is non-bookable", () => {
    const offers = (offerList as { offers: unknown[] }).offers;
    const illustrative = (offers as Array<{ provenance?: string; bookable?: boolean }>).find(
      (o) => o.provenance === "ILLUSTRATIVE",
    );
    expect(illustrative).toBeDefined();
    expect(illustrative?.bookable).toBe(false);
    const result = OfferSchema.safeParse(illustrative);
    expect(result.success).toBe(true);
  });
});

describe("frontend consumer — ErrorEnvelope", () => {
  const errorFixtures = [
    { name: "400", fixture: error400 },
    { name: "401", fixture: error401 },
    { name: "403", fixture: error403 },
    { name: "409", fixture: error409 },
    { name: "502", fixture: error502 },
  ];

  for (const { name, fixture } of errorFixtures) {
    it(`${name} error fixture validates against ErrorEnvelopeSchema`, () => {
      const result = ErrorEnvelopeSchema.safeParse(fixture);
      expect(result.success).toBe(true);
    });
  }

  it("rejects an envelope with empty reference", () => {
    const result = ErrorEnvelopeSchema.safeParse({ ...error400, reference: "" });
    expect(result.success).toBe(false);
  });
});
