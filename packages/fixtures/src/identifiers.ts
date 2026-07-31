/**
 * Stable, precomputed synthetic identifiers and timestamp helpers.
 *
 * ALL UUIDs use the `f0000xxx-` prefix which is unmistakably synthetic and
 * will never match a real UUID produced by the application (which uses
 * uuid() from PostgreSQL or crypto.randomUUID()).
 *
 * Retention periods (days) mirror the production constants defined in
 * @travel/contracts/src/retention/classification.ts.
 */

// ---------------------------------------------------------------------------
// Fixed reference instant — all seed timestamps are derived from this value.
// Do NOT use Date.now() or new Date() here; that would break determinism.
// ---------------------------------------------------------------------------

export const SEED_REFERENCE_INSTANT = new Date("2026-01-15T12:00:00.000Z");

/** Return a Date that is `offsetMs` milliseconds after the reference instant. */
export function refDate(offsetMs: number): Date {
  return new Date(SEED_REFERENCE_INSTANT.getTime() + offsetMs);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

/** Retention horizons derived from the reference instant (matching production policy). */
export const RETENTION = {
  /** RESTRICTED identity documents: reference + 90 days after trip completion. */
  identityDocument: refDate(90 * DAY_MS),
  /** CONFIDENTIAL booking/transaction rows: reference + 7 years. */
  transaction: refDate(7 * YEAR_MS),
  /** CONFIDENTIAL itinerary rows: reference + 3 years. */
  itinerary: refDate(3 * YEAR_MS),
  /** CONFIDENTIAL travel preferences: reference + 365 days. */
  preference: refDate(365 * DAY_MS),
  /** RESTRICTED session rows: reference + 30 days. */
  session: refDate(30 * DAY_MS),
};

// ---------------------------------------------------------------------------
// Stable seed identifiers — precomputed, never derived from Math.random().
// Format: f0000<segment>-0000-4000-8000-<counter>
// Segment key:
//   000 = users
//   001 = itineraries
//   002 = bookings
//   003 = processed events
//   004 = audit log entries
//   005 = travelers
//   006 = preferences
// ---------------------------------------------------------------------------

export const SEED_IDS = {
  user: {
    /** Alice Leisure — leisure planner, multi-category itinerary. */
    alice: "f0000000-0000-4000-8000-000000000001",
    /** Bob Business — frequent business traveler, saved preferences. */
    bob: "f0000000-0000-4000-8000-000000000002",
    /** Charlie Guest — itinerary originated as guest, later re-parented to account. */
    charlie: "f0000000-0000-4000-8000-000000000003",
  },

  itinerary: {
    /** Alice's multi-category trip (flight + hotel + car). */
    aliceMultiCategory: "f0000001-0000-4000-8000-000000000001",
    /** Bob's business trip with saved preferences. */
    bobBusiness: "f0000001-0000-4000-8000-000000000002",
    /** Charlie's guest-originated itinerary, re-parented after account creation. */
    charlieReparented: "f0000001-0000-4000-8000-000000000003",
  },

  booking: {
    /** CONFIRMED flight booking in Alice's itinerary. */
    flightConfirmed: "f0000002-0000-4000-8000-000000000001",
    /** CONFIRMED hotel booking in Alice's itinerary. */
    hotelConfirmed: "f0000002-0000-4000-8000-000000000002",
    /** CONFIRMED car booking in Alice's itinerary (covers all three categories). */
    carConfirmed: "f0000002-0000-4000-8000-000000000003",
    /** PENDING booking created recently — expiry is in the future. */
    pendingActive: "f0000002-0000-4000-8000-000000000004",
    /** PENDING booking whose expiresAt is in the past — exercises the expiry sweep. */
    pendingPastExpiry: "f0000002-0000-4000-8000-000000000005",
    /** CANCELLED booking — cancelled by the traveler. */
    cancelled: "f0000002-0000-4000-8000-000000000006",
    /** FAILED booking — payment provider error. */
    failed: "f0000002-0000-4000-8000-000000000007",
    /** REFUNDED booking — partial refund case. */
    refunded: "f0000002-0000-4000-8000-000000000008",
    /** EXPIRED booking — promotion-expiry path. */
    expired: "f0000002-0000-4000-8000-000000000009",
    /** Booking created with an ILLUSTRATIVE (non-bookable) offer — for structural rejection tests. */
    illustrativeOffer: "f0000002-0000-4000-8000-00000000000a",
  },

  processedEvent: {
    /** First delivery of a Stripe payment_intent.succeeded event — idempotency anchor. */
    stripePaymentSuccess: "f0000003-0000-4000-8000-000000000001",
    /** A notification event that was already handled — tests the notification consumer's exactly-once logic. */
    notificationDelivered: "f0000003-0000-4000-8000-000000000002",
  },

  traveler: {
    /** Alice as a booking traveler on the confirmed flight. */
    aliceOnFlight: "f0000005-0000-4000-8000-000000000001",
    /** Bob as a booking traveler on his business flight. */
    bobOnFlight: "f0000005-0000-4000-8000-000000000002",
  },

  preference: {
    bob: "f0000006-0000-4000-8000-000000000001",
  },
};

// ---------------------------------------------------------------------------
// Stable offer IDs (not DB rows — these are supplier offer reference IDs)
// ---------------------------------------------------------------------------

export const SEED_OFFER_IDS = {
  flightAmadueus: "SYNTH-AMADEUS-FL-001",
  hotelRapidApi: "SYNTH-RAPIDAPI-HT-001",
  carAmadueus: "SYNTH-AMADEUS-CR-001",
  illustrative: "SYNTH-ILLUSTRATIVE-001",
};

// ---------------------------------------------------------------------------
// Stable email addresses — clearly synthetic domain
// ---------------------------------------------------------------------------

export const SEED_EMAILS = {
  alice: "alice.leisure@synth.example",
  bob: "bob.business@synth.example",
  charlie: "charlie.guest@synth.example",
};
