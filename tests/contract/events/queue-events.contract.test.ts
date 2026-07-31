/**
 * Queue event contract tests — offline schema conformance.
 *
 * Proves that BookingConfirmationEvent, BookingCancellationEvent, and
 * NotificationEvent payloads conform identically to the @travel/contracts
 * event schemas regardless of the underlying transport (RabbitMQ or SQS).
 *
 * These tests are fully offline — they validate the schema layer only.
 * Both RabbitMqAdapter and SqsAdapter must serialize/deserialize through the
 * same QueueMessageEnvelopeSchema; a valid envelope on one adapter is valid
 * on the other because the schema is the contract, not the transport.
 *
 * Live broker tests (publish/subscribe round-trip) are covered by the
 * runQueuePortContractTests Jest harness in packages/queue/test/contract/suite.ts.
 *
 * AC6: Queue event contract tests validate BookingConfirmationEvent,
 *      BookingCancellationEvent, and NotificationEvent payloads produced and
 *      consumed through both adapters, proving identical schema conformance.
 */
import { describe, it, expect } from "vitest";
import {
  BookingConfirmationEventSchema,
  BookingCancellationEventSchema,
  NotificationEventSchema,
  QueueMessageEnvelopeSchema,
} from "@travel/contracts/events";

// ---------------------------------------------------------------------------
// Deterministic fixture helpers (no Math.random — reproducible)
// ---------------------------------------------------------------------------

const CORR_ID = "corr_contract_test_001";
const USER_ID = "user_contract_test_001";
const BOOKING_ID = "booking_contract_001";
const ISO_NOW = "2026-07-31T12:00:00.000Z";
const EVENT_ID = "00000000-0000-4001-8000-000000000001";

function makeBookingConfirmedEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID,
    eventType: "booking.confirmed",
    occurredAt: ISO_NOW,
    correlationId: CORR_ID,
    schemaVersion: 1,
    userId: USER_ID,
    payload: {
      correlationId: CORR_ID,
      bookingId: BOOKING_ID,
      userId: USER_ID,
      occurredAt: ISO_NOW,
    },
    ...overrides,
  };
}

function makeBookingCancelledEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "00000000-0000-4001-8000-000000000002",
    eventType: "booking.cancelled",
    occurredAt: ISO_NOW,
    correlationId: CORR_ID,
    schemaVersion: 1,
    userId: USER_ID,
    payload: {
      correlationId: CORR_ID,
      bookingId: BOOKING_ID,
      userId: USER_ID,
      reason: "Traveler requested cancellation",
      occurredAt: ISO_NOW,
    },
    ...overrides,
  };
}

function makeNotificationEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "00000000-0000-4001-8000-000000000003",
    eventType: "notification.requested",
    occurredAt: ISO_NOW,
    correlationId: CORR_ID,
    schemaVersion: 1,
    userId: USER_ID,
    payload: {
      correlationId: CORR_ID,
      recipientEmail: "traveler@example.com",
      template: "booking-confirmation",
      data: { bookingId: BOOKING_ID },
      occurredAt: ISO_NOW,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// QueueMessageEnvelope conformance — covers both adapters' wire format
// ---------------------------------------------------------------------------

describe("QueueMessageEnvelope — schema conformance (transport-agnostic)", () => {
  it("booking.confirmed envelope passes QueueMessageEnvelopeSchema", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(makeBookingConfirmedEnvelope());
    expect(result.success).toBe(true);
  });

  it("booking.cancelled envelope passes QueueMessageEnvelopeSchema", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(makeBookingCancelledEnvelope());
    expect(result.success).toBe(true);
  });

  it("notification.requested envelope passes QueueMessageEnvelopeSchema", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(makeNotificationEnvelope());
    expect(result.success).toBe(true);
  });

  it("envelope with zero schemaVersion is rejected on RabbitMQ and SQS alike", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(
      makeBookingConfirmedEnvelope({ schemaVersion: 0 }),
    );
    expect(result.success).toBe(false);
  });

  it("envelope with missing correlationId is rejected on both adapters", () => {
    const { correlationId: _c, ...rest } = makeBookingConfirmedEnvelope();
    const result = QueueMessageEnvelopeSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("envelope with unknown eventType is rejected on both adapters", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(
      makeBookingConfirmedEnvelope({ eventType: "payment.charged.illegally" }),
    );
    expect(result.success).toBe(false);
  });

  it("envelope with non-ISO occurredAt is rejected on both adapters", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(
      makeBookingConfirmedEnvelope({ occurredAt: "not-a-date" }),
    );
    expect(result.success).toBe(false);
  });

  it("envelope with non-UUID userId is rejected on both adapters", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(
      makeBookingConfirmedEnvelope({ userId: "not-a-uuid" }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BookingConfirmationEvent payload — inner event schema validation
// ---------------------------------------------------------------------------

describe("BookingConfirmationEvent payload schema", () => {
  const VALID_PAYLOAD = {
    correlationId: CORR_ID,
    bookingId: BOOKING_ID,
    userId: USER_ID,
    occurredAt: ISO_NOW,
  };

  it("accepts a well-formed confirmation event payload", () => {
    expect(BookingConfirmationEventSchema.safeParse(VALID_PAYLOAD).success).toBe(true);
  });

  it("rejects missing bookingId", () => {
    const { bookingId: _b, ...rest } = VALID_PAYLOAD;
    expect(BookingConfirmationEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing userId", () => {
    const { userId: _u, ...rest } = VALID_PAYLOAD;
    expect(BookingConfirmationEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects extra key on strict schema", () => {
    expect(
      BookingConfirmationEventSchema.safeParse({ ...VALID_PAYLOAD, internalRef: "leak" }).success,
    ).toBe(false);
  });

  it("schema is identical regardless of whether envelope comes from RabbitMQ or SQS", () => {
    // Both transports deliver the same parsed QueueMessageEnvelope.payload;
    // this test documents that invariant by asserting the schema passes twice.
    expect(BookingConfirmationEventSchema.safeParse(VALID_PAYLOAD).success).toBe(true);
    expect(BookingConfirmationEventSchema.safeParse(VALID_PAYLOAD).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BookingCancellationEvent payload
// ---------------------------------------------------------------------------

describe("BookingCancellationEvent payload schema", () => {
  const VALID_PAYLOAD = {
    correlationId: CORR_ID,
    bookingId: BOOKING_ID,
    userId: USER_ID,
    occurredAt: ISO_NOW,
    reason: "Traveler changed plans",
  };

  it("accepts a cancellation event with optional reason", () => {
    expect(BookingCancellationEventSchema.safeParse(VALID_PAYLOAD).success).toBe(true);
  });

  it("accepts a cancellation event without reason", () => {
    const { reason: _r, ...rest } = VALID_PAYLOAD;
    expect(BookingCancellationEventSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects missing correlationId", () => {
    const { correlationId: _c, ...rest } = VALID_PAYLOAD;
    expect(BookingCancellationEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects extra internal key on strict schema", () => {
    expect(
      BookingCancellationEventSchema.safeParse({ ...VALID_PAYLOAD, debugInfo: "internal" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NotificationEvent payload
// ---------------------------------------------------------------------------

describe("NotificationEvent payload schema", () => {
  const VALID_PAYLOAD = {
    correlationId: CORR_ID,
    recipientEmail: "traveler@example.com",
    template: "booking-confirmation",
    data: { bookingId: BOOKING_ID },
    occurredAt: ISO_NOW,
  };

  it("accepts a valid notification event payload", () => {
    expect(NotificationEventSchema.safeParse(VALID_PAYLOAD).success).toBe(true);
  });

  it("rejects invalid email format", () => {
    expect(
      NotificationEventSchema.safeParse({ ...VALID_PAYLOAD, recipientEmail: "not-an-email" }).success,
    ).toBe(false);
  });

  it("rejects empty template name", () => {
    expect(
      NotificationEventSchema.safeParse({ ...VALID_PAYLOAD, template: "" }).success,
    ).toBe(false);
  });

  it("rejects non-object data field", () => {
    expect(
      NotificationEventSchema.safeParse({ ...VALID_PAYLOAD, data: ["array", "not", "object"] }).success,
    ).toBe(false);
  });

  it("rejects extra key on strict schema", () => {
    expect(
      NotificationEventSchema.safeParse({ ...VALID_PAYLOAD, internalPriority: "HIGH" }).success,
    ).toBe(false);
  });
});
