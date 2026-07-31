/**
 * Consumer-driven fixture test for search-service.
 * Owner: search-service team.
 */
import { describe, expect, it } from "vitest";
import {
  FlightSearchRequestSchema,
  HotelSearchRequestSchema,
  CarRentalSearchRequestSchema,
  OfferSchema,
} from "@travel/contracts/search";
import flightRequest from "./fixtures/flight-search-request.json" with { type: "json" };
import hotelRequest from "../../../packages/contracts/test/fixtures/search/hotel-search-request.json" with { type: "json" };
import carRequest from "../../../packages/contracts/test/fixtures/search/car-rental-search-request.json" with { type: "json" };
import offer from "../../../packages/contracts/test/fixtures/search/offer.json" with { type: "json" };

describe("search-service consumer — FlightSearchRequest", () => {
  it("fixture validates against FlightSearchRequestSchema", () => {
    const result = FlightSearchRequestSchema.safeParse(flightRequest);
    expect(result.success).toBe(true);
  });

  it("rejects a flight request with invalid IATA code", () => {
    const result = FlightSearchRequestSchema.safeParse({ ...flightRequest, departureAirport: "jfkx" });
    expect(result.success).toBe(false);
  });
});

describe("search-service consumer — HotelSearchRequest", () => {
  it("fixture validates against HotelSearchRequestSchema", () => {
    const result = HotelSearchRequestSchema.safeParse(hotelRequest);
    expect(result.success).toBe(true);
  });
});

describe("search-service consumer — CarRentalSearchRequest", () => {
  it("fixture validates against CarRentalSearchRequestSchema", () => {
    const result = CarRentalSearchRequestSchema.safeParse(carRequest);
    expect(result.success).toBe(true);
  });
});

describe("search-service consumer — Offer", () => {
  it("offer fixture validates against OfferSchema", () => {
    const result = OfferSchema.safeParse(offer);
    expect(result.success).toBe(true);
  });

  it("rejects ILLUSTRATIVE offer with bookable: true", () => {
    const result = OfferSchema.safeParse({ ...offer, provenance: "ILLUSTRATIVE", bookable: true });
    expect(result.success).toBe(false);
  });
});
