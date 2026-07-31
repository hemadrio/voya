import { describe, expect, it } from "vitest";
import { ILLUSTRATIVE_NOT_BOOKABLE_MESSAGE, OfferSchema } from "../../src/search/offer.js";

const validOffer = () => ({
  id: "offer_01HZY",
  provenance: "AMADEUS" as const,
  bookable: true,
  title: "Nonstop JFK to LAX",
  price: "412.50",
  currency: "USD",
  rating: 4.5,
  reviews: 1280,
  details: { airline: "Delta" },
  expiresAt: "2030-06-01T00:15:00.000Z",
  freshness: "FRESH" as const,
});

describe("OfferSchema", () => {
  it("accepts a valid bookable AMADEUS offer", () => {
    expect(OfferSchema.safeParse(validOffer()).success).toBe(true);
  });

  it("accepts a valid non-bookable ILLUSTRATIVE offer", () => {
    const result = OfferSchema.safeParse({ ...validOffer(), provenance: "ILLUSTRATIVE", bookable: false });
    expect(result.success).toBe(true);
  });

  it("rejects ILLUSTRATIVE + bookable:true, naming the bookable field", () => {
    const result = OfferSchema.safeParse({ ...validOffer(), provenance: "ILLUSTRATIVE", bookable: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "bookable");
      expect(issue?.message).toBe(ILLUSTRATIVE_NOT_BOOKABLE_MESSAGE);
    }
  });

  it("rejects the legacy provider enum values", () => {
    for (const legacy of ["HOTELS_API", "PRICELINE", "AI_FALLBACK"]) {
      const result = OfferSchema.safeParse({ ...validOffer(), provenance: legacy });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a missing freshness label", () => {
    const { freshness: _freshness, ...rest } = validOffer();
    const result = OfferSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra keys", () => {
    const result = OfferSchema.safeParse({ ...validOffer(), extra: "nope" });
    expect(result.success).toBe(false);
  });
});
