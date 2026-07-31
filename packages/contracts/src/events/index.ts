import { z } from "zod";
import { correlationId, identifier, isoDateString } from "../common/primitives.js";

/**
 * Every event schema requires `correlationId` so a single traveler action
 * (checkout, cancellation, ...) can be traced end to end across the SQS FIFO
 * queue, the notification consumer, and downstream Pino/OpenTelemetry logs.
 */

export const BookingConfirmationEventSchema = z
  .object({
    correlationId,
    bookingId: identifier,
    userId: identifier,
    occurredAt: isoDateString,
  })
  .strict();
export type BookingConfirmationEvent = z.infer<typeof BookingConfirmationEventSchema>;

export const BookingCancellationEventSchema = z
  .object({
    correlationId,
    bookingId: identifier,
    userId: identifier,
    reason: z.string().trim().min(1).optional(),
    occurredAt: isoDateString,
  })
  .strict();
export type BookingCancellationEvent = z.infer<typeof BookingCancellationEventSchema>;

export const NotificationEventSchema = z
  .object({
    correlationId,
    recipientEmail: z.string().trim().toLowerCase().email(),
    template: z.string().trim().min(1),
    data: z.record(z.string(), z.unknown()),
    occurredAt: isoDateString,
  })
  .strict();
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
