/**
 * Consumer-driven fixture test for ai-service.
 *
 * The AI service generates ILLUSTRATIVE offers — structural guarantees:
 *   - provenance MUST be "ILLUSTRATIVE"
 *   - bookable MUST be false (enforced by OfferSchema)
 *
 * Owner: ai-service team.
 */
import { describe, expect, it } from "vitest";
import { OfferSchema } from "@travel/contracts/search";
import illustrativeOffer from "./fixtures/illustrative-offer.json" with { type: "json" };

describe("ai-service consumer — ILLUSTRATIVE Offer", () => {
  it("illustrative offer fixture validates against OfferSchema", () => {
    const result = OfferSchema.safeParse(illustrativeOffer);
    expect(result.success).toBe(true);
  });

  it("OfferSchema structurally rejects ILLUSTRATIVE offer with bookable: true", () => {
    const result = OfferSchema.safeParse({ ...illustrativeOffer, bookable: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const bookableIssue = result.error.issues.find((i) => i.path.includes("bookable"));
      expect(bookableIssue).toBeDefined();
    }
  });

  it("ILLUSTRATIVE offer with bookable: false is always valid regardless of other fields", () => {
    const result = OfferSchema.safeParse({ ...illustrativeOffer, provenance: "ILLUSTRATIVE", bookable: false });
    expect(result.success).toBe(true);
  });
});
