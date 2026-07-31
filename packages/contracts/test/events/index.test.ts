import { describe, expect, it } from "vitest";
import {
  BookingCancellationEventSchema,
  BookingConfirmationEventSchema,
  NotificationEventSchema,
} from "../../src/events/index.js";
import { CORRELATION_ID_REQUIRED_MESSAGE } from "../../src/common/primitives.js";
import confirmationFixture from "../fixtures/events/booking-confirmation-event.json" with { type: "json" };
import cancellationFixture from "../fixtures/events/booking-cancellation-event.json" with { type: "json" };
import notificationFixture from "../fixtures/events/notification-event.json" with { type: "json" };

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
