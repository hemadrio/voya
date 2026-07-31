/**
 * Schema-drift guard: every exported payload fixture must parse successfully
 * against its corresponding @travel/contracts schema.
 *
 * A breaking contract change that leaves a fixture invalid will surface here
 * rather than in a distant runtime test, reducing the debug cycle length.
 * The test names include the schema name so a CI failure points directly to
 * which fixture/schema pair drifted.
 */

import { describe, it, expect } from "vitest";
import {
  OfferSchema,
  FlightSearchRequestSchema,
  HotelSearchRequestSchema,
  CarRentalSearchRequestSchema,
  PaymentIntentRequestSchema,
  PaymentIntentResponseSchema,
  BookingResponseSchema,
} from "@travel/contracts";

import {
  SYNTHETIC_FLIGHT_OFFER,
  SYNTHETIC_HOTEL_OFFER,
  SYNTHETIC_CAR_OFFER,
  SYNTHETIC_ILLUSTRATIVE_OFFER,
  SYNTHETIC_FLIGHT_SEARCH_REQUEST,
  SYNTHETIC_HOTEL_SEARCH_REQUEST,
  SYNTHETIC_CAR_SEARCH_REQUEST,
} from "../src/payloads/search.js";
import {
  SYNTHETIC_PAYMENT_INTENT_REQUEST as PAYMENT_REQ,
  SYNTHETIC_PAYMENT_INTENT_RESPONSE as PAYMENT_RESP,
} from "../src/payloads/payment.js";
import { makeBooking, SEED_IDS } from "../src/factories/index.js";

describe("OfferSchema drift guard", () => {
  it("SYNTHETIC_FLIGHT_OFFER parses against OfferSchema", () => {
    const result = OfferSchema.safeParse(SYNTHETIC_FLIGHT_OFFER);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  it("SYNTHETIC_HOTEL_OFFER parses against OfferSchema", () => {
    const result = OfferSchema.safeParse(SYNTHETIC_HOTEL_OFFER);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  it("SYNTHETIC_CAR_OFFER parses against OfferSchema", () => {
    const result = OfferSchema.safeParse(SYNTHETIC_CAR_OFFER);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  it("SYNTHETIC_ILLUSTRATIVE_OFFER parses against OfferSchema (bookable=false)", () => {
    const result = OfferSchema.safeParse(SYNTHETIC_ILLUSTRATIVE_OFFER);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  it("SYNTHETIC_ILLUSTRATIVE_OFFER with bookable=true fails OfferSchema (structural guard)", () => {
    const result = OfferSchema.safeParse({ ...SYNTHETIC_ILLUSTRATIVE_OFFER, bookable: true });
    expect(result.success).toBe(false);
  });
});

describe("FlightSearchRequestSchema drift guard", () => {
  it("SYNTHETIC_FLIGHT_SEARCH_REQUEST parses against FlightSearchRequestSchema", () => {
    const result = FlightSearchRequestSchema.safeParse(SYNTHETIC_FLIGHT_SEARCH_REQUEST);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });
});

describe("HotelSearchRequestSchema drift guard", () => {
  it("SYNTHETIC_HOTEL_SEARCH_REQUEST parses against HotelSearchRequestSchema", () => {
    const result = HotelSearchRequestSchema.safeParse(SYNTHETIC_HOTEL_SEARCH_REQUEST);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });
});

describe("CarRentalSearchRequestSchema drift guard", () => {
  it("SYNTHETIC_CAR_SEARCH_REQUEST parses against CarRentalSearchRequestSchema", () => {
    const result = CarRentalSearchRequestSchema.safeParse(SYNTHETIC_CAR_SEARCH_REQUEST);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });
});

describe("PaymentIntentRequestSchema drift guard", () => {
  it("SYNTHETIC_PAYMENT_INTENT_REQUEST parses against PaymentIntentRequestSchema", () => {
    const result = PaymentIntentRequestSchema.safeParse(PAYMENT_REQ);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });
});

describe("PaymentIntentResponseSchema drift guard", () => {
  it("SYNTHETIC_PAYMENT_INTENT_RESPONSE parses against PaymentIntentResponseSchema", () => {
    const result = PaymentIntentResponseSchema.safeParse(PAYMENT_RESP);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });
});

describe("BookingResponseSchema drift guard", () => {
  it("makeBooking() produces a shape compatible with BookingResponseSchema fields", () => {
    const b = makeBooking();
    // The BookingResponseSchema expects the API wire shape (no DB-only fields).
    const wireShape = {
      id: b.id,
      bookingType: b.bookingType,
      status: b.status,
      offerId: b.offerId,
      totalPrice: b.totalPrice,
      currency: b.currency,
      passengers: [
        {
          firstName: "Alice",
          lastName: "Leisure",
          dateOfBirth: new Date("1990-03-15").toISOString(),
          email: "alice.leisure@synth.example",
        },
      ],
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    };
    const result = BookingResponseSchema.safeParse(wireShape);
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });
});
