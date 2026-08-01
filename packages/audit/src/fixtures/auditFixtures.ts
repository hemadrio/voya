/**
 * Committed audit fixtures for WO-041 acceptance criterion AC10.
 *
 * Covers every BookingAction: CREATED, MODIFIED, CANCELLED, BOOKING_CONFIRMED
 * (maps to PAYMENT_RECEIVED semantics), REFUNDED, EXPIRED.
 *
 * All fixtures use stable, non-PII actorIds and redaction-safe state payloads.
 * Import these into unit/integration tests to avoid duplicating event shapes.
 */

import type { AuditEventInput } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Shared reference data
// ---------------------------------------------------------------------------

export const FIXTURE_ACTOR_TRAVELER = "user-fixture-001";
export const FIXTURE_ACTOR_SYSTEM = "system";
export const FIXTURE_ACTOR_SUPPORT = "support-fixture-001";
export const FIXTURE_BOOKING_ID = "booking-fixture-0000-0000-0001";
export const FIXTURE_CORRELATION_ID = "trace-fixture-0000-0001";

// ---------------------------------------------------------------------------
// AC10 fixture set: one per BookingAction
// ---------------------------------------------------------------------------

/** BOOKING_CREATED — initial PENDING state created by a traveler. */
export const FIXTURE_BOOKING_CREATED: AuditEventInput = {
  actorId: FIXTURE_ACTOR_TRAVELER,
  actorRole: "traveler",
  action: "BOOKING_CREATED",
  resourceType: "booking",
  resourceId: FIXTURE_BOOKING_ID,
  previousState: null,
  newState: {
    status: "PENDING",
    listingId: "listing-fixture-001",
    checkIn: "2025-07-01",
    checkOut: "2025-07-08",
    totalNights: 7,
    currency: "USD",
  },
  correlationId: FIXTURE_CORRELATION_ID,
  occurredAt: new Date("2025-06-01T10:00:00.000Z"),
  reason: "INITIAL_BOOKING",
};

/** BOOKING_MODIFIED — traveler changed check-out date. */
export const FIXTURE_BOOKING_MODIFIED: AuditEventInput = {
  actorId: FIXTURE_ACTOR_TRAVELER,
  actorRole: "traveler",
  action: "BOOKING_MODIFIED",
  resourceType: "booking",
  resourceId: FIXTURE_BOOKING_ID,
  previousState: {
    checkOut: "2025-07-08",
    totalNights: 7,
  },
  newState: {
    checkOut: "2025-07-10",
    totalNights: 9,
  },
  correlationId: FIXTURE_CORRELATION_ID,
  occurredAt: new Date("2025-06-02T14:30:00.000Z"),
  reason: "DATE_CHANGE_REQUESTED",
};

/** BOOKING_CONFIRMED — payment received, booking confirmed by system. */
export const FIXTURE_BOOKING_CONFIRMED: AuditEventInput = {
  actorId: FIXTURE_ACTOR_SYSTEM,
  actorRole: "system",
  action: "BOOKING_CONFIRMED",
  resourceType: "booking",
  resourceId: FIXTURE_BOOKING_ID,
  previousState: {
    status: "PENDING",
  },
  newState: {
    status: "CONFIRMED",
    paidAt: "2025-06-02T15:00:00.000Z",
  },
  correlationId: FIXTURE_CORRELATION_ID,
  occurredAt: new Date("2025-06-02T15:00:00.000Z"),
  // No reason — system-initiated event
};

/** BOOKING_CANCELLED — traveler-initiated cancellation with reason. */
export const FIXTURE_BOOKING_CANCELLED: AuditEventInput = {
  actorId: FIXTURE_ACTOR_TRAVELER,
  actorRole: "traveler",
  action: "BOOKING_CANCELLED",
  resourceType: "booking",
  resourceId: FIXTURE_BOOKING_ID,
  previousState: {
    status: "CONFIRMED",
  },
  newState: {
    status: "CANCELLED",
    cancelledAt: "2025-06-15T09:00:00.000Z",
  },
  correlationId: FIXTURE_CORRELATION_ID,
  occurredAt: new Date("2025-06-15T09:00:00.000Z"),
  reason: "CANCELLATION_REQUESTED",
};

/** BOOKING_REFUNDED — support agent processed the refund. */
export const FIXTURE_BOOKING_REFUNDED: AuditEventInput = {
  actorId: FIXTURE_ACTOR_SUPPORT,
  actorRole: "support_agent",
  action: "BOOKING_REFUNDED",
  resourceType: "booking",
  resourceId: FIXTURE_BOOKING_ID,
  previousState: {
    status: "CANCELLED",
    refundAmount: null,
  },
  newState: {
    status: "REFUNDED",
    refundAmount: 630,
    currency: "USD",
    refundedAt: "2025-06-16T11:00:00.000Z",
  },
  correlationId: "trace-fixture-refund-001",
  occurredAt: new Date("2025-06-16T11:00:00.000Z"),
  reason: "FULL_REFUND_APPROVED",
};

/** BOOKING_EXPIRED — system auto-expires a PENDING booking. */
export const FIXTURE_BOOKING_EXPIRED: AuditEventInput = {
  actorId: FIXTURE_ACTOR_SYSTEM,
  actorRole: "system",
  action: "BOOKING_EXPIRED",
  resourceType: "booking",
  resourceId: "booking-fixture-0000-0000-0002",
  previousState: {
    status: "PENDING",
  },
  newState: {
    status: "EXPIRED",
    expiredAt: "2025-06-01T10:30:00.000Z",
  },
  occurredAt: new Date("2025-06-01T10:30:00.000Z"),
  // No reason — system-initiated expiry
};

/** BOOKING_PRICE_REVALIDATED — system re-validated price before confirmation. */
export const FIXTURE_BOOKING_PRICE_REVALIDATED: AuditEventInput = {
  actorId: FIXTURE_ACTOR_SYSTEM,
  actorRole: "system",
  action: "BOOKING_PRICE_REVALIDATED",
  resourceType: "booking",
  resourceId: FIXTURE_BOOKING_ID,
  previousState: {
    quotedPrice: 700,
    currency: "USD",
  },
  newState: {
    quotedPrice: 720,
    currency: "USD",
    priceChangedAt: "2025-06-02T14:55:00.000Z",
  },
  correlationId: FIXTURE_CORRELATION_ID,
  occurredAt: new Date("2025-06-02T14:55:00.000Z"),
  // No reason — system-initiated revalidation
};

// ---------------------------------------------------------------------------
// Convenience: all booking fixtures in chronological lifecycle order
// ---------------------------------------------------------------------------

/** Complete booking lifecycle trail in insertion order. */
export const FIXTURE_BOOKING_LIFECYCLE: AuditEventInput[] = [
  FIXTURE_BOOKING_CREATED,
  FIXTURE_BOOKING_MODIFIED,
  FIXTURE_BOOKING_PRICE_REVALIDATED,
  FIXTURE_BOOKING_CONFIRMED,
  FIXTURE_BOOKING_CANCELLED,
  FIXTURE_BOOKING_REFUNDED,
];
