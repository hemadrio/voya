/**
 * Booking seed factories — covers every lifecycle state and the illustrative
 * (non-bookable) offer case required by the structural rejection tests.
 *
 * Offer snapshots are obviously synthetic JSONB blobs. The illustrative offer
 * has bookable=false and provenance="ILLUSTRATIVE", which the booking service
 * must structurally reject — this fixture lets that path be exercised without
 * creating a real booking.
 */

import {
  SEED_IDS,
  SEED_EMAILS,
  SEED_OFFER_IDS,
  SEED_REFERENCE_INSTANT,
  refDate,
  RETENTION,
} from "../identifiers.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface BookingSeed {
  id: string;
  userId: string;
  bookingType: "FLIGHT" | "HOTEL" | "CAR";
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "FAILED" | "REFUNDED" | "EXPIRED";
  offerId: string;
  totalPrice: string;
  currency: string;
  contactEmail: string;
  contactPhone: string | null;
  idempotencyKey: string;
  searchResultSnapshot: object | null;
  provenance: string | null;
  bookable: boolean;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  travelersMigratedAt: Date | null;
  classification: "CONFIDENTIAL";
  purgeAfter: Date | null;
}

/** Canonical offer snapshot template for supplier-backed bookings. */
function syntheticOfferSnapshot(offerId: string, provenance: string, bookable: boolean): object {
  return {
    id: offerId,
    provenance,
    bookable,
    title: "Synthetic travel offer — not a real product",
    price: "412.50",
    currency: "USD",
    details: { synthetic: true },
    expiresAt: refDate(30 * MIN).toISOString(),
    freshness: "FRESH",
  };
}

export function makeBooking(overrides: Partial<BookingSeed> = {}): BookingSeed {
  return {
    id: SEED_IDS.booking.flightConfirmed,
    userId: SEED_IDS.user.alice,
    bookingType: "FLIGHT",
    status: "CONFIRMED",
    offerId: SEED_OFFER_IDS.flightAmadueus,
    totalPrice: "412.50",
    currency: "USD",
    contactEmail: SEED_EMAILS.alice,
    contactPhone: null,
    idempotencyKey: "idem-f0000002-flight-confirmed",
    searchResultSnapshot: syntheticOfferSnapshot(SEED_OFFER_IDS.flightAmadueus, "AMADEUS", true),
    provenance: "AMADEUS",
    bookable: true,
    createdAt: SEED_REFERENCE_INSTANT,
    updatedAt: refDate(5 * MIN),
    expiresAt: null,
    travelersMigratedAt: refDate(5 * MIN),
    classification: "CONFIDENTIAL",
    purgeAfter: RETENTION.transaction,
    ...overrides,
  };
}

/** All seed bookings used by prisma/seed.ts. */
export const SEED_BOOKINGS: BookingSeed[] = [
  // 1 — CONFIRMED flight (Alice)
  makeBooking(),

  // 2 — CONFIRMED hotel (Alice)
  makeBooking({
    id: SEED_IDS.booking.hotelConfirmed,
    bookingType: "HOTEL",
    offerId: SEED_OFFER_IDS.hotelRapidApi,
    totalPrice: "210.00",
    contactEmail: SEED_EMAILS.alice,
    idempotencyKey: "idem-f0000002-hotel-confirmed",
    searchResultSnapshot: syntheticOfferSnapshot(SEED_OFFER_IDS.hotelRapidApi, "RAPIDAPI", true),
    provenance: "RAPIDAPI",
    createdAt: refDate(1 * MIN),
    updatedAt: refDate(6 * MIN),
  }),

  // 3 — CONFIRMED car (Alice) — completes all three booking categories in her itinerary
  makeBooking({
    id: SEED_IDS.booking.carConfirmed,
    bookingType: "CAR",
    offerId: SEED_OFFER_IDS.carAmadueus,
    totalPrice: "89.00",
    contactEmail: SEED_EMAILS.alice,
    idempotencyKey: "idem-f0000002-car-confirmed",
    searchResultSnapshot: syntheticOfferSnapshot(SEED_OFFER_IDS.carAmadueus, "AMADEUS", true),
    createdAt: refDate(2 * MIN),
    updatedAt: refDate(7 * MIN),
  }),

  // 4 — PENDING active (Bob) — expiry in the future, exercises normal pending state
  makeBooking({
    id: SEED_IDS.booking.pendingActive,
    userId: SEED_IDS.user.bob,
    bookingType: "FLIGHT",
    status: "PENDING",
    offerId: SEED_OFFER_IDS.flightAmadueus,
    totalPrice: "520.00",
    contactEmail: SEED_EMAILS.bob,
    idempotencyKey: "idem-f0000002-pending-active",
    searchResultSnapshot: syntheticOfferSnapshot(SEED_OFFER_IDS.flightAmadueus, "AMADEUS", true),
    createdAt: refDate(3 * MIN),
    updatedAt: refDate(3 * MIN),
    // Expires 30 minutes after creation — still in the future relative to reference.
    expiresAt: refDate(3 * MIN + 30 * MIN),
    travelersMigratedAt: null,
    purgeAfter: null,
  }),

  // 5 — PENDING past expiry (Bob) — expiresAt is 1 hour before reference; exercises the pending-expiry sweep.
  makeBooking({
    id: SEED_IDS.booking.pendingPastExpiry,
    userId: SEED_IDS.user.bob,
    bookingType: "HOTEL",
    status: "PENDING",
    offerId: SEED_OFFER_IDS.hotelRapidApi,
    totalPrice: "195.00",
    contactEmail: SEED_EMAILS.bob,
    idempotencyKey: "idem-f0000002-pending-past-expiry",
    searchResultSnapshot: syntheticOfferSnapshot(SEED_OFFER_IDS.hotelRapidApi, "RAPIDAPI", true),
    createdAt: refDate(-2 * HOUR),
    updatedAt: refDate(-2 * HOUR),
    expiresAt: refDate(-1 * HOUR),
    travelersMigratedAt: null,
    purgeAfter: null,
  }),

  // 6 — CANCELLED (Charlie)
  makeBooking({
    id: SEED_IDS.booking.cancelled,
    userId: SEED_IDS.user.charlie,
    bookingType: "FLIGHT",
    status: "CANCELLED",
    offerId: SEED_OFFER_IDS.flightAmadueus,
    totalPrice: "300.00",
    contactEmail: SEED_EMAILS.charlie,
    idempotencyKey: "idem-f0000002-cancelled",
    createdAt: refDate(-1 * DAY),
    updatedAt: refDate(-1 * DAY + 30 * MIN),
    expiresAt: null,
    purgeAfter: RETENTION.transaction,
  }),

  // 7 — FAILED (Charlie)
  makeBooking({
    id: SEED_IDS.booking.failed,
    userId: SEED_IDS.user.charlie,
    bookingType: "HOTEL",
    status: "FAILED",
    offerId: SEED_OFFER_IDS.hotelRapidApi,
    totalPrice: "150.00",
    contactEmail: SEED_EMAILS.charlie,
    idempotencyKey: "idem-f0000002-failed",
    createdAt: refDate(-2 * DAY),
    updatedAt: refDate(-2 * DAY + 10 * MIN),
    expiresAt: null,
    purgeAfter: RETENTION.transaction,
  }),

  // 8 — REFUNDED partial (Alice) — payment refund path
  makeBooking({
    id: SEED_IDS.booking.refunded,
    userId: SEED_IDS.user.alice,
    bookingType: "CAR",
    status: "REFUNDED",
    offerId: SEED_OFFER_IDS.carAmadueus,
    totalPrice: "89.00",
    contactEmail: SEED_EMAILS.alice,
    idempotencyKey: "idem-f0000002-refunded",
    createdAt: refDate(-3 * DAY),
    updatedAt: refDate(-3 * DAY + 1 * HOUR),
    expiresAt: null,
    purgeAfter: RETENTION.transaction,
  }),

  // 9 — EXPIRED (Bob) — promotion window closed
  makeBooking({
    id: SEED_IDS.booking.expired,
    userId: SEED_IDS.user.bob,
    bookingType: "CAR",
    status: "EXPIRED",
    offerId: SEED_OFFER_IDS.carAmadueus,
    totalPrice: "75.00",
    contactEmail: SEED_EMAILS.bob,
    idempotencyKey: "idem-f0000002-expired",
    createdAt: refDate(-4 * DAY),
    updatedAt: refDate(-4 * DAY + 35 * MIN),
    expiresAt: refDate(-4 * DAY + 30 * MIN),
    purgeAfter: RETENTION.transaction,
  }),

  // 10 — ILLUSTRATIVE offer booking attempt (Alice) — provenance=ILLUSTRATIVE, bookable=false.
  // This row is seeded as status=FAILED because the booking service structurally rejects
  // ILLUSTRATIVE offers; the fixture exists so downstream tests can assert that rejection
  // without creating a real PENDING booking.
  makeBooking({
    id: SEED_IDS.booking.illustrativeOffer,
    userId: SEED_IDS.user.alice,
    bookingType: "FLIGHT",
    status: "FAILED",
    offerId: SEED_OFFER_IDS.illustrative,
    totalPrice: "0.01",
    contactEmail: SEED_EMAILS.alice,
    idempotencyKey: "idem-f0000002-illustrative-rejected",
    searchResultSnapshot: syntheticOfferSnapshot(SEED_OFFER_IDS.illustrative, "ILLUSTRATIVE", false),
    provenance: "ILLUSTRATIVE",
    bookable: false,
    createdAt: refDate(-5 * DAY),
    updatedAt: refDate(-5 * DAY + 1 * MIN),
    expiresAt: null,
    purgeAfter: RETENTION.transaction,
  }),
];
