import { describe, expect, it } from "vitest";
import { FlightSearchRequestSchema } from "../../src/search/flight.js";
import { OfferSchema } from "../../src/search/offer.js";
import { BookingConfirmationEventSchema } from "../../src/events/index.js";
import flightFixture from "../fixtures/search/flight-search-request.json" with { type: "json" };
import offerFixture from "../fixtures/search/offer.json" with { type: "json" };
import eventFixture from "../fixtures/events/booking-confirmation-event.json" with { type: "json" };

/**
 * Proves that a payload produced by `JSON.stringify` on the browser side —
 * i.e. plain strings for every date field, exactly as `fetch` would send it
 * — round-trips through the schema and produces equal `Date` values, with
 * no manual transformation required by the caller.
 */
describe("JSON round-trip", () => {
  it("round-trips a flight search request, coercing ISO strings to equal Date values", () => {
    const serialized = JSON.stringify(flightFixture);
    const reparsed = JSON.parse(serialized);

    const result = FlightSearchRequestSchema.safeParse(reparsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.departureDate).toEqual(new Date(flightFixture.departureDate));
      expect(result.data.returnDate).toEqual(new Date(flightFixture.returnDate));
    }
  });

  it("round-trips a unified offer, coercing expiresAt to an equal Date value", () => {
    const reparsed = JSON.parse(JSON.stringify(offerFixture));
    const result = OfferSchema.safeParse(reparsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expiresAt).toEqual(new Date(offerFixture.expiresAt));
      expect(result.data.expiresAt).toBeInstanceOf(Date);
    }
  });

  it("round-trips a booking confirmation event, preserving correlationId and coercing occurredAt", () => {
    const reparsed = JSON.parse(JSON.stringify(eventFixture));
    const result = BookingConfirmationEventSchema.safeParse(reparsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.correlationId).toBe(eventFixture.correlationId);
      expect(result.data.occurredAt).toEqual(new Date(eventFixture.occurredAt));
    }
  });

  it("produces a schema output that re-serializes back to equivalent ISO strings", () => {
    const reparsed = JSON.parse(JSON.stringify(offerFixture));
    const result = OfferSchema.safeParse(reparsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expiresAt.toISOString()).toBe(offerFixture.expiresAt);
    }
  });
});
