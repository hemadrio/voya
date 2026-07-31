/**
 * Consumer-driven fixture test for reporting-service.
 * Owner: reporting-service team.
 */
import { describe, expect, it } from "vitest";
import { BookingResponseSchema, ItinerarySchema } from "@travel/contracts/booking";
import bookingResponse from "../../../packages/contracts/test/fixtures/booking/booking-response.json" with { type: "json" };
import itinerary from "../../../packages/contracts/test/fixtures/booking/itinerary.json" with { type: "json" };

describe("reporting-service consumer — BookingResponse", () => {
  it("fixture validates against BookingResponseSchema", () => {
    const result = BookingResponseSchema.safeParse(bookingResponse);
    expect(result.success).toBe(true);
  });

  it("rejects a response missing the id field", () => {
    const { id: _, ...withoutId } = bookingResponse as typeof bookingResponse & { id?: unknown };
    const result = BookingResponseSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
  });
});

describe("reporting-service consumer — Itinerary", () => {
  it("itinerary fixture validates against ItinerarySchema", () => {
    const result = ItinerarySchema.safeParse(itinerary);
    expect(result.success).toBe(true);
  });
});
