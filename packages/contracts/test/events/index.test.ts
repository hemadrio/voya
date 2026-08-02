import { describe, expect, it } from "vitest";
import {
  BookingCancellationEventSchema,
  BookingConfirmationEventSchema,
  NotificationEventSchema,
  QueueMessageEnvelopeSchema,
} from "../../src/events/index.js";
import { CORRELATION_ID_REQUIRED_MESSAGE } from "../../src/common/primitives.js";
import confirmationFixture from "../fixtures/events/booking-confirmation-event.json" with { type: "json" };
import cancellationFixture from "../fixtures/events/booking-cancellation-event.json" with { type: "json" };
import notificationFixture from "../fixtures/events/notification-event.json" with { type: "json" };
import envelopeFixture from "../fixtures/events/queue-message-envelope.json" with { type: "json" };

describe("BookingConfirmationEventSchema", () => {
  it("accepts the committed fixture", () => {
    expect(BookingConfirmationEventSchema.safeParse(confirmationFixture).success).toBe(true);
  });

  it("rejects a missing correlationId", () => {
    const { correlationId: _correlationId, ...rest } = confirmationFixture as Record<string, unknown>;
    const result = BookingConfirmationEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an empty correlationId with the exact message", () => {
    const result = BookingConfirmationEventSchema.safeParse({ ...confirmationFixture, correlationId: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "correlationId");
      expect(issue?.message).toBe(CORRELATION_ID_REQUIRED_MESSAGE);
    }
  });
});

describe("BookingCancellationEventSchema", () => {
  it("accepts the committed fixture", () => {
    expect(BookingCancellationEventSchema.safeParse(cancellationFixture).success).toBe(true);
  });

  it("accepts a payload without the optional reason", () => {
    const { reason: _reason, ...rest } = cancellationFixture as Record<string, unknown>;
    expect(BookingCancellationEventSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects a missing correlationId", () => {
    const { correlationId: _correlationId, ...rest } = cancellationFixture as Record<string, unknown>;
    expect(BookingCancellationEventSchema.safeParse(rest).success).toBe(false);
  });
});

describe("NotificationEventSchema", () => {
  it("accepts the committed fixture", () => {
    expect(NotificationEventSchema.safeParse(notificationFixture).success).toBe(true);
  });

  it("rejects a missing correlationId", () => {
    const { correlationId: _correlationId, ...rest } = notificationFixture as Record<string, unknown>;
    expect(NotificationEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an invalid recipient email", () => {
    expect(NotificationEventSchema.safeParse({ ...notificationFixture, recipientEmail: "nope" }).success).toBe(false);
  });
});

describe("QueueMessageEnvelopeSchema", () => {
  it("accepts the committed fixture", () => {
    const result = QueueMessageEnvelopeSchema.safeParse(envelopeFixture);
    expect(result.success).toBe(true);
  });

  it("rejects missing correlationId", () => {
    const { correlationId: _correlationId, ...rest } = envelopeFixture as Record<string, unknown>;
    const result = QueueMessageEnvelopeSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("correlationId");
    }
  });

  it("rejects unknown eventType", () => {
    const result = QueueMessageEnvelopeSchema.safeParse({
      ...envelopeFixture,
      eventType: "payment.charged",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("eventType");
    }
  });

  it("rejects non-ISO occurredAt", () => {
    const result = QueueMessageEnvelopeSchema.safeParse({
      ...envelopeFixture,
      occurredAt: "not-a-date",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("occurredAt");
    }
  });

  it("rejects non-UUID eventId", () => {
    const result = QueueMessageEnvelopeSchema.safeParse({
      ...envelopeFixture,
      eventId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("eventId");
    }
  });

  it("rejects schemaVersion below 1", () => {
    const result = QueueMessageEnvelopeSchema.safeParse({
      ...envelopeFixture,
      schemaVersion: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("schemaVersion");
    }
  });

  it("rejects non-UUID userId", () => {
    const result = QueueMessageEnvelopeSchema.safeParse({
      ...envelopeFixture,
      userId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("userId");
    }
  });

  it("round-trips through JSON serialisation", () => {
    const serialised = JSON.parse(JSON.stringify(envelopeFixture)) as unknown;
    const result = QueueMessageEnvelopeSchema.safeParse(serialised);
    expect(result.success).toBe(true);
  });
});
