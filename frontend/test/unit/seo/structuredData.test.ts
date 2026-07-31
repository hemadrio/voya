/**
 * Unit tests for lib/seo/structuredData.ts
 *
 * Covers:
 * - Required @context and @type fields on all serializers
 * - aggregateRating omitted when reviewCount is 0 or undefined
 * - Breadcrumb position numbering
 * - FAQ schema shape
 * - No aggregateRating emitted on LodgingBusiness with zero reviews
 */

import { describe, it, expect } from "vitest";
import {
  serializeOrganization,
  serializeBreadcrumbs,
  serializeLodgingBusiness,
  serializeProduct,
  serializeFAQ,
  toJsonLdScript,
} from "@/lib/seo/structuredData";
import {
  FIXTURE_ORGANIZATION,
  FIXTURE_BREADCRUMBS,
  FIXTURE_LODGING_WITH_REVIEWS,
  FIXTURE_LODGING_NO_REVIEWS,
  FIXTURE_PRODUCT,
  FIXTURE_FAQ,
} from "@/test/fixtures/seo";

describe("serializeOrganization", () => {
  it("emits @context and @type", () => {
    const result = serializeOrganization(FIXTURE_ORGANIZATION);
    expect(result["@context"]).toBe("https://schema.org");
    expect(result["@type"]).toBe("Organization");
  });

  it("includes name and url", () => {
    const result = serializeOrganization(FIXTURE_ORGANIZATION);
    expect(result["name"]).toBe(FIXTURE_ORGANIZATION.name);
    expect(result["url"]).toBe(FIXTURE_ORGANIZATION.url);
  });

  it("includes logo as ImageObject", () => {
    const result = serializeOrganization(FIXTURE_ORGANIZATION);
    const logo = result["logo"] as Record<string, unknown>;
    expect(logo["@type"]).toBe("ImageObject");
    expect(logo["url"]).toBe(FIXTURE_ORGANIZATION.logo);
  });

  it("includes sameAs array", () => {
    const result = serializeOrganization(FIXTURE_ORGANIZATION);
    expect(Array.isArray(result["sameAs"])).toBe(true);
    expect((result["sameAs"] as string[]).length).toBe(2);
  });

  it("omits logo when not provided", () => {
    const result = serializeOrganization({ name: "Test", url: "https://test.com" });
    expect(result["logo"]).toBeUndefined();
  });
});

describe("serializeBreadcrumbs", () => {
  it("emits @type BreadcrumbList", () => {
    const result = serializeBreadcrumbs(FIXTURE_BREADCRUMBS);
    expect(result["@type"]).toBe("BreadcrumbList");
  });

  it("numbers items starting at 1", () => {
    const result = serializeBreadcrumbs(FIXTURE_BREADCRUMBS);
    const items = result["itemListElement"] as Array<Record<string, unknown>>;
    expect(items[0]?.["position"]).toBe(1);
    expect(items[1]?.["position"]).toBe(2);
    expect(items[2]?.["position"]).toBe(3);
  });

  it("sets item to the URL", () => {
    const result = serializeBreadcrumbs(FIXTURE_BREADCRUMBS);
    const items = result["itemListElement"] as Array<Record<string, unknown>>;
    expect(items[0]?.["item"]).toBe(FIXTURE_BREADCRUMBS[0]?.url);
  });
});

describe("serializeLodgingBusiness — with reviews", () => {
  it("emits @type LodgingBusiness", () => {
    const result = serializeLodgingBusiness(FIXTURE_LODGING_WITH_REVIEWS);
    expect(result["@type"]).toBe("LodgingBusiness");
  });

  it("includes aggregateRating when reviewCount > 0", () => {
    const result = serializeLodgingBusiness(FIXTURE_LODGING_WITH_REVIEWS);
    const rating = result["aggregateRating"] as Record<string, unknown>;
    expect(rating).toBeDefined();
    expect(rating["@type"]).toBe("AggregateRating");
    expect(rating["ratingValue"]).toBe(4.6);
    expect(rating["reviewCount"]).toBe(2847);
  });

  it("includes offers as makesOffer", () => {
    const result = serializeLodgingBusiness(FIXTURE_LODGING_WITH_REVIEWS);
    const offers = result["makesOffer"] as Array<Record<string, unknown>>;
    expect(Array.isArray(offers)).toBe(true);
    expect(offers.length).toBe(1);
    expect(offers[0]?.["price"]).toBe(420);
  });
});

describe("serializeLodgingBusiness — zero reviews (edge case)", () => {
  it("OMITS aggregateRating when reviewCount is 0", () => {
    const result = serializeLodgingBusiness(FIXTURE_LODGING_NO_REVIEWS);
    expect(result["aggregateRating"]).toBeUndefined();
  });

  it("still emits name and url", () => {
    const result = serializeLodgingBusiness(FIXTURE_LODGING_NO_REVIEWS);
    expect(result["name"]).toBe(FIXTURE_LODGING_NO_REVIEWS.name);
  });
});

describe("serializeProduct", () => {
  it("emits @type Product", () => {
    const result = serializeProduct(FIXTURE_PRODUCT);
    expect(result["@type"]).toBe("Product");
  });

  it("includes aggregateRating when reviewCount > 0", () => {
    const result = serializeProduct(FIXTURE_PRODUCT);
    const rating = result["aggregateRating"] as Record<string, unknown>;
    expect(rating).toBeDefined();
    expect(rating["ratingValue"]).toBe(4.2);
  });

  it("omits aggregateRating when reviewCount is undefined", () => {
    const result = serializeProduct({ name: "Test Offer" });
    expect(result["aggregateRating"]).toBeUndefined();
  });

  it("wraps brand in Brand schema", () => {
    const result = serializeProduct(FIXTURE_PRODUCT);
    const brand = result["brand"] as Record<string, unknown>;
    expect(brand["@type"]).toBe("Brand");
    expect(brand["name"]).toBe("Air France");
  });
});

describe("serializeFAQ", () => {
  it("emits @type FAQPage", () => {
    const result = serializeFAQ(FIXTURE_FAQ);
    expect(result["@type"]).toBe("FAQPage");
  });

  it("wraps each item in Question with acceptedAnswer", () => {
    const result = serializeFAQ(FIXTURE_FAQ);
    const entities = result["mainEntity"] as Array<Record<string, unknown>>;
    expect(entities.length).toBe(2);
    expect(entities[0]?.["@type"]).toBe("Question");
    const answer = entities[0]?.["acceptedAnswer"] as Record<string, unknown>;
    expect(answer["@type"]).toBe("Answer");
    expect(answer["text"]).toBe(FIXTURE_FAQ[0]?.answer);
  });
});

describe("toJsonLdScript", () => {
  it("serializes to compact JSON without indentation", () => {
    const data = { "@type": "Organization", name: "Test" };
    const script = toJsonLdScript(data);
    expect(script).toBe(JSON.stringify(data));
    expect(script).not.toContain("\n");
  });
});
