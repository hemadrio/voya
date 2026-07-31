import { describe, expect, it } from "vitest";
import { BookingResponseSchema, ItinerarySchema } from "../../src/booking/response.js";
import bookingFixture from "../fixtures/booking/booking-response.json" with { type: "json" };
import itineraryFixture from "../fixtures/booking/itinerary.json" with { type: "json" };

describe("BookingResponseSchema", () => {
  it("accepts the committed fixture", () => {
    const result = BookingResponseSchema.safeParse(bookingFixture);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid booking status", () => {
    const result = BookingResponseSchema.safeParse({ ...bookingFixture, status: "UNKNOWN" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra keys", () => {
    const result = BookingResponseSchema.safeParse({ ...bookingFixture, extra: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("ItinerarySchema", () => {
  it("accepts the committed fixture", () => {
    expect(ItinerarySchema.safeParse(itineraryFixture).success).toBe(true);
  });

  it("rejects a missing userId", () => {
    const { userId: _userId, ...rest } = itineraryFixture as Record<string, unknown>;
    expect(ItinerarySchema.safeParse(rest).success).toBe(false);
  });
});
