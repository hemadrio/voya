import { z } from "zod";

/**
 * Enum schemas mirroring the platform's Prisma model enums (`User`,
 * `Booking`, `Itinerary`, `TravelPreferences`, `BookingAuditLog`, `Session`).
 * This package never touches the database — these values are duplicated
 * here deliberately, as plain string literal unions, so contracts stays
 * dependency-light while remaining the authoritative wire-level shape.
 */

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export const BookingTypeSchema = z.enum(["FLIGHT", "HOTEL", "CAR"]);
export type BookingType = z.infer<typeof BookingTypeSchema>;

export const BookingStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "REFUNDED",
  "EXPIRED",
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const BookingAuditActionSchema = z.enum([
  "CREATED",
  "STATUS_CHANGED",
  "PAYMENT_CONFIRMED",
  "CANCELLED",
  "REFUNDED",
  "ACCESS_DENIED",
]);
export type BookingAuditAction = z.infer<typeof BookingAuditActionSchema>;

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export const PaymentStatusSchema = z.enum([
  "REQUIRES_PAYMENT_METHOD",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "REFUNDED",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

// ---------------------------------------------------------------------------
// Search / offer
// ---------------------------------------------------------------------------

export const SeatClassSchema = z.enum(["ECONOMY", "BUSINESS", "FIRST"]);
export type SeatClass = z.infer<typeof SeatClassSchema>;

export const CarClassSchema = z.enum(["ECONOMY", "COMPACT", "MIDSIZE", "PREMIUM"]);
export type CarClass = z.infer<typeof CarClassSchema>;

export const HotelStarRatingSchema = z.union([z.literal(3), z.literal(4), z.literal(5)]);
export type HotelStarRating = z.infer<typeof HotelStarRatingSchema>;

/**
 * Provenance replaces the legacy provider enum
 * (`AMADEUS`/`HOTELS_API`/`PRICELINE`/`AI_FALLBACK`). Only `AMADEUS` and
 * `RAPIDAPI` denote real, bookable supplier inventory; `ILLUSTRATIVE`
 * denotes AI-generated or placeholder inventory that must never be
 * bookable (enforced in `search/offer.ts`).
 */
export const ProvenanceSchema = z.enum(["AMADEUS", "RAPIDAPI", "ILLUSTRATIVE"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const FreshnessLabelSchema = z.enum(["FRESH", "STALE"]);
export type FreshnessLabel = z.infer<typeof FreshnessLabelSchema>;

// ---------------------------------------------------------------------------
// Auth / roles
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(["traveler", "support_agent", "system"]);
export type Role = z.infer<typeof RoleSchema>;
