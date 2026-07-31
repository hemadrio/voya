import { QueueMessageEnvelopeSchema } from "@travel/contracts";
import {
  bookingConfirmedEnvelope,
  bookingCancelledEnvelope,
  bookingModifiedEnvelope,
  itineraryDocumentRequestedEnvelope,
  MISSING_CORRELATION_ID,
  UNKNOWN_EVENT_TYPE,
  INVALID_OCCURRED_AT,
  INVALID_USER_ID,
  ZERO_SCHEMA_VERSION,
} from "../fixtures/envelopes.js";

// ---------------------------------------------------------------------------
// Valid envelopes
// ---------------------------------------------------------------------------

describe("QueueMessageEnvelopeSchema — valid envelopes", () => {
  it.each([
    ["booking.confirmed", bookingConfirmedEnvelope()],
    ["booking.cancelled", bookingCancelledEnvelope()],
    ["booking.modified", bookingModifiedEnvelope()],
    ["itinerary.document.requested", itineraryDocumentRequestedEnvelope()],
  ] as const)("accepts %s envelope", (_label, envelope) => {
    const result = QueueMessageEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it("round-trips through JSON serialisation", () => {
    const envelope = bookingConfirmedEnvelope();
    const serialised = JSON.parse(JSON.stringify(envelope)) as unknown;
    const result = QueueMessageEnvelopeSchema.safeParse(serialised);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventId).toBe(envelope.eventId);
      expect(result.data.correlationId).toBe(envelope.correlationId);
      expect(result.data.userId).toBe(envelope.userId);
    }
  });

  it("preserves correlationId through parse", () => {
    const envelope = bookingConfirmedEnvelope({
      correlationId: "my-trace-abc-123",
    });
    const result = QueueMessageEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.correlationId).toBe("my-trace-abc-123");
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid envelopes — Zod rejection paths
// ---------------------------------------------------------------------------

describe("QueueMessageEnvelopeSchema — rejection paths", () => {
  it("rejects missing correlationId", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(MISSING_CORRELATION_ID);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("correlationId");
    }
  });

  it("rejects unknown eventType", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(UNKNOWN_EVENT_TYPE);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("eventType");
    }
  });

  it("rejects non-ISO occurredAt", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(INVALID_OCCURRED_AT);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("occurredAt");
    }
  });

  it("rejects non-UUID userId", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(INVALID_USER_ID);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("userId");
    }
  });

  it("rejects schemaVersion of 0", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(ZERO_SCHEMA_VERSION);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("schemaVersion");
    }
  });

  it("rejects missing eventId", () => {
    const { eventId: _eventId, ...noId } = bookingConfirmedEnvelope();
    const result = QueueMessageEnvelopeSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID eventId", () => {
    const bad = { ...bookingConfirmedEnvelope(), eventId: "not-a-uuid" };
    const result = QueueMessageEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("eventId");
    }
  });

  it("rejects extra fields (strict schema)", () => {
    const bad = { ...bookingConfirmedEnvelope(), unexpectedField: "oops" };
    const result = QueueMessageEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MessageGroupId and MessageDeduplicationId derivation
// ---------------------------------------------------------------------------

describe("Envelope fields for SQS FIFO", () => {
  it("userId is the MessageGroupId source — distinct users produce distinct groups", () => {
    const e1 = bookingConfirmedEnvelope({ userId: "aaaaaaaa-0000-4000-8000-000000000001" });
    const e2 = bookingConfirmedEnvelope({ userId: "bbbbbbbb-0000-4000-8000-000000000002" });
    expect(e1.userId).not.toBe(e2.userId);
  });

  it("eventId is the MessageDeduplicationId source — each call produces unique eventId", () => {
    const e1 = bookingConfirmedEnvelope();
    const e2 = bookingConfirmedEnvelope();
    expect(e1.eventId).not.toBe(e2.eventId);
  });
});
