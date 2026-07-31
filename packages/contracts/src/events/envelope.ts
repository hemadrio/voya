import { z } from "zod";
import { correlationId } from "../common/primitives.js";

/**
 * The set of domain event types carried by the async queue.
 * This enum is the authoritative list — adding a new event type here is the
 * only change required in @travel/contracts; queue adapters and consumers
 * derive their routing from this value.
 */
export const EventTypeSchema = z.enum([
  "booking.confirmed",
  "booking.cancelled",
  "booking.modified",
  "itinerary.document.requested",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * QueueMessageEnvelope — the typed wrapper around every async domain event.
 *
 * Every message published to the queue (RabbitMQ or SQS) is a JSON-serialised
 * instance of this schema. Consumers always parse the raw JSON against this
 * schema before inspecting the payload; a message that fails parse is nacked
 * immediately and routed to the DLQ rather than retried.
 *
 * Field semantics:
 *   eventId          - UUID v4. Used as SQS MessageDeduplicationId for FIFO
 *                      idempotency (5-minute dedup window).
 *   eventType        - One of the EventType enum values. Consumers route on
 *                      this field rather than on queue/exchange names.
 *   occurredAt       - ISO-8601 datetime when the domain fact occurred,
 *                      not when the message was published.
 *   correlationId    - Inbound HTTP request correlation ID. Propagated through
 *                      the queue so Pino logs and OTel spans on both sides of
 *                      the async hop share the same trace.
 *   schemaVersion    - Monotonically increasing integer. Consumers can use
 *                      this to reject messages from a future schema version
 *                      they do not understand without breaking the DLQ path.
 *   userId           - UUID v4 of the user who triggered the domain event.
 *                      Used as SQS MessageGroupId for FIFO ordering — a
 *                      traveller never receives a cancellation email ahead of
 *                      their confirmation.
 *   payload          - Event-specific fields. Callers are responsible for
 *                      validating the payload against the appropriate domain
 *                      event schema (BookingConfirmationEvent, etc.) before
 *                      publishing and after consuming.
 */
export const QueueMessageEnvelopeSchema = z
  .object({
    eventId: z.string().uuid({ message: "eventId must be a valid UUID v4" }),
    eventType: EventTypeSchema,
    occurredAt: z
      .string({ message: "occurredAt must be an ISO-8601 datetime string" })
      .datetime({ message: "occurredAt must be an ISO-8601 datetime string", offset: true }),
    correlationId,
    schemaVersion: z
      .number()
      .int({ message: "schemaVersion must be a positive integer" })
      .min(1, { message: "schemaVersion must be a positive integer" }),
    userId: z.string().uuid({ message: "userId must be a valid UUID v4" }),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type QueueMessageEnvelope = z.infer<typeof QueueMessageEnvelopeSchema>;
