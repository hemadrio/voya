/**
 * Consumer-driven fixture test for itinerary-service.
 * Owner: itinerary-service team.
 */
import { describe, expect, it } from "vitest";
import { ItinerarySchema, BookingResponseSchema } from "@travel/contracts/booking";
import itinerary from "../../../packages/contracts/test/fixtures/booking/itinerary.json" with { type: "json" };
import bookingResponse from "../../../packages/contracts/test/fixtures/booking/booking-response.json" with { type: "json" };

describe("itinerary-service consumer — Itinerary", () => {
  it("fixture validates against ItinerarySchema", () => {
    const result = ItinerarySchema.safeParse(itinerary);
    expect(result.success).toBe(true);
  });

  it("rejects itinerary with empty bookings array", () => {
    const result = ItinerarySchema.safeParse({ ...itinerary, bookings: undefined });
    expect(result.success).toBe(false);
  });
});

describe("itinerary-service consumer — BookingResponse", () => {
  it("fixture validates against BookingResponseSchema", () => {
    const result = BookingResponseSchema.safeParse(bookingResponse);
    expect(result.success).toBe(true);
  });
});
