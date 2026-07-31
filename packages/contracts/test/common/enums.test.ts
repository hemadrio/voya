import { describe, expect, it } from "vitest";
import {
  BookingAuditActionSchema,
  BookingStatusSchema,
  BookingTypeSchema,
  CarClassSchema,
  FreshnessLabelSchema,
  HotelStarRatingSchema,
  PaymentStatusSchema,
  ProvenanceSchema,
  RoleSchema,
  SeatClassSchema,
} from "../../src/common/enums.js";

describe("enum schemas", () => {
  it("BookingTypeSchema accepts valid values and rejects unknown ones", () => {
    expect(BookingTypeSchema.safeParse("FLIGHT").success).toBe(true);
    expect(BookingTypeSchema.safeParse("HOTEL").success).toBe(true);
    expect(BookingTypeSchema.safeParse("CAR").success).toBe(true);
    expect(BookingTypeSchema.safeParse("CRUISE").success).toBe(false);
  });

  it("BookingStatusSchema accepts every documented state", () => {
    for (const value of ["PENDING", "CONFIRMED", "CANCELLED", "FAILED", "REFUNDED", "EXPIRED"]) {
      expect(BookingStatusSchema.safeParse(value).success).toBe(true);
    }
    expect(BookingStatusSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  it("BookingAuditActionSchema accepts every documented action", () => {
    for (const value of [
      "CREATED",
      "STATUS_CHANGED",
      "PAYMENT_CONFIRMED",
      "CANCELLED",
      "REFUNDED",
      "ACCESS_DENIED",
    ]) {
      expect(BookingAuditActionSchema.safeParse(value).success).toBe(true);
    }
    expect(BookingAuditActionSchema.safeParse("DELETED").success).toBe(false);
  });

  it("PaymentStatusSchema accepts every documented status", () => {
    for (const value of ["REQUIRES_PAYMENT_METHOD", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED"]) {
      expect(PaymentStatusSchema.safeParse(value).success).toBe(true);
    }
    expect(PaymentStatusSchema.safeParse("PENDING").success).toBe(false);
  });

  it("SeatClassSchema matches the flight search API contract", () => {
    expect(SeatClassSchema.safeParse("ECONOMY").success).toBe(true);
    expect(SeatClassSchema.safeParse("BUSINESS").success).toBe(true);
    expect(SeatClassSchema.safeParse("FIRST").success).toBe(true);
    expect(SeatClassSchema.safeParse("PREMIUM_ECONOMY").success).toBe(false);
  });

  it("CarClassSchema matches the car search API contract", () => {
    for (const value of ["ECONOMY", "COMPACT", "MIDSIZE", "PREMIUM"]) {
      expect(CarClassSchema.safeParse(value).success).toBe(true);
    }
    expect(CarClassSchema.safeParse("LUXURY").success).toBe(false);
  });

  it("HotelStarRatingSchema only accepts 3, 4, or 5", () => {
    expect(HotelStarRatingSchema.safeParse(3).success).toBe(true);
    expect(HotelStarRatingSchema.safeParse(4).success).toBe(true);
    expect(HotelStarRatingSchema.safeParse(5).success).toBe(true);
    expect(HotelStarRatingSchema.safeParse(2).success).toBe(false);
    expect(HotelStarRatingSchema.safeParse(1).success).toBe(false);
  });

  it("ProvenanceSchema no longer accepts the legacy provider values", () => {
    expect(ProvenanceSchema.safeParse("AMADEUS").success).toBe(true);
    expect(ProvenanceSchema.safeParse("RAPIDAPI").success).toBe(true);
    expect(ProvenanceSchema.safeParse("ILLUSTRATIVE").success).toBe(true);
    expect(ProvenanceSchema.safeParse("HOTELS_API").success).toBe(false);
    expect(ProvenanceSchema.safeParse("PRICELINE").success).toBe(false);
    expect(ProvenanceSchema.safeParse("AI_FALLBACK").success).toBe(false);
  });

  it("FreshnessLabelSchema accepts FRESH and STALE only", () => {
    expect(FreshnessLabelSchema.safeParse("FRESH").success).toBe(true);
    expect(FreshnessLabelSchema.safeParse("STALE").success).toBe(true);
    expect(FreshnessLabelSchema.safeParse("EXPIRED").success).toBe(false);
  });

  it("RoleSchema matches traveler|support_agent|system exactly", () => {
    expect(RoleSchema.safeParse("traveler").success).toBe(true);
    expect(RoleSchema.safeParse("support_agent").success).toBe(true);
    expect(RoleSchema.safeParse("system").success).toBe(true);
    expect(RoleSchema.safeParse("admin").success).toBe(false);
    expect(RoleSchema.safeParse("TRAVELER").success).toBe(false);
  });
});
