/**
 * Consumer-driven fixture test for booking-service.
 *
 * Asserts that every fixture still parses successfully against the current
 * @travel/contracts schemas that this service depends on.  A narrowing change
 * in contracts will fail here before reaching the booking-service's own logic.
 *
 * Fixture provenance: all fixtures represent real booking-service traffic
 * shapes.  Owner: booking-service team.
 */
import { describe, expect, it } from "vitest";
import {
  CreateBookingRequestSchema,
  BookingResponseSchema,
  ItinerarySchema,
} from "@travel/contracts/booking";
import createBookingRequest from "./fixtures/create-booking-request.json" with { type: "json" };
import bookingResponseFixture from "../../../packages/contracts/test/fixtures/booking/booking-response.json" with { type: "json" };
import itineraryFixture from "../../../packages/contracts/test/fixtures/booking/itinerary.json" with { type: "json" };

describe("booking-service consumer — CreateBookingRequest", () => {
  it("fixture validates against CreateBookingRequestSchema", () => {
    const result = CreateBookingRequestSchema.safeParse(createBookingRequest);
    expect(result.success).toBe(true);
  });

  it("rejects a mutated fixture with empty passengers array", () => {
    const result = CreateBookingRequestSchema.safeParse({ ...createBookingRequest, passengers: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a fixture with an invalid bookingType", () => {
    const result = CreateBookingRequestSchema.safeParse({ ...createBookingRequest, bookingType: "TRAIN" });
    expect(result.success).toBe(false);
  });
});

describe("booking-service consumer — BookingResponse", () => {
  it("fixture validates against BookingResponseSchema", () => {
    const result = BookingResponseSchema.safeParse(bookingResponseFixture);
    expect(result.success).toBe(true);
  });

  it("rejects a booking response with unknown status", () => {
    const result = BookingResponseSchema.safeParse({ ...bookingResponseFixture, status: "UNKNOWN_STATUS" });
    expect(result.success).toBe(false);
  });
});

describe("booking-service consumer — Itinerary", () => {
  it("itinerary fixture validates against ItinerarySchema", () => {
    const result = ItinerarySchema.safeParse(itineraryFixture);
    expect(result.success).toBe(true);
  });
});
