/**
 * Fixture factory producing valid and invalid QueueMessageEnvelope samples.
 *
 * Used by both unit tests and the shared contract test suite so no live
 * supplier or broker call is needed in CI.
 */

import type { QueueMessageEnvelope } from "@travel/contracts";
import type { EventType } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Deterministic UUIDs for fixtures (not random — reproducible in tests)
// ---------------------------------------------------------------------------

const FIXTURE_USER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const FIXTURE_BOOKING_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const FIXTURE_CORRELATION_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";

let _counter = 0;
function nextEventId(): string {
  _counter += 1;
  const hex = _counter.toString(16).padStart(8, "0");
  return `00000000-0000-4000-8000-${hex}${"0".repeat(4)}`;
}

function makeEnvelope(
  overrides: Partial<QueueMessageEnvelope> & { eventType: EventType },
): QueueMessageEnvelope {
  return {
    eventId: nextEventId(),
    occurredAt: "2027-01-15T10:00:00.000Z",
    correlationId: FIXTURE_CORRELATION_ID,
    schemaVersion: 1,
    userId: FIXTURE_USER_ID,
    payload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid fixtures
// ---------------------------------------------------------------------------

export function bookingConfirmedEnvelope(
  overrides?: Partial<QueueMessageEnvelope>,
): QueueMessageEnvelope {
  return makeEnvelope({
    eventType: "booking.confirmed",
    payload: {
      bookingId: FIXTURE_BOOKING_ID,
      userId: FIXTURE_USER_ID,
      confirmedAt: "2027-01-15T10:00:00.000Z",
    },
    ...overrides,
  });
}

export function bookingCancelledEnvelope(
  overrides?: Partial<QueueMessageEnvelope>,
): QueueMessageEnvelope {
  return makeEnvelope({
    eventType: "booking.cancelled",
    payload: {
      bookingId: FIXTURE_BOOKING_ID,
      reason: "Customer requested cancellation",
    },
    ...overrides,
  });
}

export function bookingModifiedEnvelope(
  overrides?: Partial<QueueMessageEnvelope>,
): QueueMessageEnvelope {
  return makeEnvelope({
    eventType: "booking.modified",
    payload: {
      bookingId: FIXTURE_BOOKING_ID,
      changes: { seatClass: "BUSINESS" },
    },
    ...overrides,
  });
}

export function itineraryDocumentRequestedEnvelope(
  overrides?: Partial<QueueMessageEnvelope>,
): QueueMessageEnvelope {
  return makeEnvelope({
    eventType: "itinerary.document.requested",
    payload: {
      bookingId: FIXTURE_BOOKING_ID,
      documentType: "PDF_ITINERARY",
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Invalid fixtures (for rejection tests)
// ---------------------------------------------------------------------------

/** Missing correlationId */
export const MISSING_CORRELATION_ID = {
  eventId: "d4e5f6a7-b8c9-0123-defa-234567890123",
  eventType: "booking.confirmed",
  occurredAt: "2027-01-15T10:00:00.000Z",
  schemaVersion: 1,
  userId: FIXTURE_USER_ID,
  payload: {},
} as const;

/** Unknown eventType */
export const UNKNOWN_EVENT_TYPE = {
  eventId: "e5f6a7b8-c9d0-1234-efab-345678901234",
  eventType: "payment.charged",
  occurredAt: "2027-01-15T10:00:00.000Z",
  correlationId: FIXTURE_CORRELATION_ID,
  schemaVersion: 1,
  userId: FIXTURE_USER_ID,
  payload: {},
} as const;

/** Non-ISO occurredAt */
export const INVALID_OCCURRED_AT = {
  eventId: "f6a7b8c9-d0e1-2345-fabc-456789012345",
  eventType: "booking.confirmed",
  occurredAt: "not-a-date",
  correlationId: FIXTURE_CORRELATION_ID,
  schemaVersion: 1,
  userId: FIXTURE_USER_ID,
  payload: {},
} as const;

/** Invalid userId (not a UUID) */
export const INVALID_USER_ID = {
  eventId: "a7b8c9d0-e1f2-3456-abcd-567890123456",
  eventType: "booking.confirmed",
  occurredAt: "2027-01-15T10:00:00.000Z",
  correlationId: FIXTURE_CORRELATION_ID,
  schemaVersion: 1,
  userId: "not-a-uuid",
  payload: {},
} as const;

/** schemaVersion of zero (below minimum) */
export const ZERO_SCHEMA_VERSION = {
  eventId: "b8c9d0e1-f2a3-4567-bcde-678901234567",
  eventType: "booking.confirmed",
  occurredAt: "2027-01-15T10:00:00.000Z",
  correlationId: FIXTURE_CORRELATION_ID,
  schemaVersion: 0,
  userId: FIXTURE_USER_ID,
  payload: {},
} as const;
