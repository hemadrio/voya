/**
 * Consumer-driven fixture test for notification-service.
 * Owner: notification-service team.
 */
import { describe, expect, it } from "vitest";
import {
  BookingConfirmationEventSchema,
  BookingCancellationEventSchema,
  NotificationEventSchema,
} from "@travel/contracts/events";
import bookingConfirmation from "../../../packages/contracts/test/fixtures/events/booking-confirmation-event.json" with { type: "json" };
import bookingCancellation from "../../../packages/contracts/test/fixtures/events/booking-cancellation-event.json" with { type: "json" };
import notificationEvent from "../../../packages/contracts/test/fixtures/events/notification-event.json" with { type: "json" };

describe("notification-service consumer — BookingConfirmationEvent", () => {
  it("fixture validates against BookingConfirmationEventSchema", () => {
    const result = BookingConfirmationEventSchema.safeParse(bookingConfirmation);
    expect(result.success).toBe(true);
  });

  it("rejects an event without correlationId", () => {
    const { correlationId: _, ...withoutCorrelation } = bookingConfirmation as typeof bookingConfirmation & { correlationId?: unknown };
    const result = BookingConfirmationEventSchema.safeParse(withoutCorrelation);
    expect(result.success).toBe(false);
  });
});

describe("notification-service consumer — BookingCancellationEvent", () => {
  it("fixture validates against BookingCancellationEventSchema", () => {
    const result = BookingCancellationEventSchema.safeParse(bookingCancellation);
    expect(result.success).toBe(true);
  });
});

describe("notification-service consumer — NotificationEvent", () => {
  it("fixture validates against NotificationEventSchema", () => {
    const result = NotificationEventSchema.safeParse(notificationEvent);
    expect(result.success).toBe(true);
  });
});
