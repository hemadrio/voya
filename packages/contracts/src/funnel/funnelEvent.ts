/**
 * FunnelEvent — versioned schema for the pseudonymised conversion funnel (WO-106).
 *
 * Design invariants:
 *   - PII fields (email, firstName, lastName, dateOfBirth, passportNumber, phone,
 *     raw userId) are forbidden by strict object shapes; any attempt to include them
 *     fails Zod parse.
 *   - pseudonymousActorId is the ONLY actor reference: HMAC-SHA256 of userId or
 *     anonymous session id, keyed by FUNNEL_PSEUDONYM_KEY from Secrets Manager.
 *   - attributes is a bounded record of primitive values — no nested objects —
 *     to prevent free-form PII smuggling.
 *   - schemaVersion allows additive evolution; parsers must tolerate unknown future
 *     versions by inspecting schemaVersion before deserialising.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Event type enum — 12 business-significant transitions (AC1)
// ---------------------------------------------------------------------------

export const FunnelEventTypeSchema = z.enum([
  "session_started",
  "search_performed",
  "results_viewed",
  "offer_selected",
  "itinerary_created",
  "booking_created",
  "payment_confirmed",
  "conversation_started",
  "shortlist_presented",
  "conversation_handoff",
  "guest_registered",
  "preference_saved",
]);
export type FunnelEventType = z.infer<typeof FunnelEventTypeSchema>;

// ---------------------------------------------------------------------------
// Category enum — travel verticals
// ---------------------------------------------------------------------------

export const FunnelCategorySchema = z.enum([
  "FLIGHT",
  "HOTEL",
  "CAR",
  "MULTI",
  "ASSISTANT",
  "AUTH",
  "UNKNOWN",
]);
export type FunnelCategory = z.infer<typeof FunnelCategorySchema>;

// ---------------------------------------------------------------------------
// Bounded attributes record — primitive values only; no nested objects
// ---------------------------------------------------------------------------

const FunnelAttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

/**
 * Bounded attributes record for a single funnel event.
 * Maximum 20 keys; values are primitives only — this prevents free-form PII
 * from entering the funnel store via the attributes field.
 */
export const FunnelAttributesSchema = z
  .record(FunnelAttributeValueSchema)
  .refine((obj) => Object.keys(obj).length <= 20, {
    message: "attributes must have at most 20 keys",
  });

export type FunnelAttributes = z.infer<typeof FunnelAttributesSchema>;

// ---------------------------------------------------------------------------
// FunnelEvent — core schema (AC1)
// ---------------------------------------------------------------------------

/**
 * PII-exclusion guard:
 * The schema is a strict Zod object that explicitly names only the safe fields.
 * Any key in the PII_FIELDS list added to an event will cause parse to fail.
 */
const PII_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "dateOfBirth",
  "passportNumber",
  "phone",
  "userId",
] as const;

// Build a PII rejection shape where each PII key maps to z.never()
// so passing any of those fields causes a Zod parse error.
const piiNeverFields: Record<string, z.ZodNever> = {};
for (const field of PII_FIELDS) {
  piiNeverFields[field] = z.never();
}

export const FunnelEventSchema = z
  .object({
    /** Monotonically increasing schema version — currently 1. */
    schemaVersion: z.literal(1),
    /** The 12 business-significant funnel transitions. */
    eventType: FunnelEventTypeSchema,
    /** UTC timestamp of the business transition. */
    occurredAt: z.string().datetime(),
    /** Platform correlation identifier from X-Correlation-Id / ULID. */
    correlationId: z.string().min(1),
    /**
     * HMAC-SHA256 of userId or anonymous session id, keyed by
     * FUNNEL_PSEUDONYM_KEY. Never the raw user identifier.
     */
    pseudonymousActorId: z.string().min(1),
    /** Session identifier — present for every event. */
    sessionId: z.string().min(1),
    /** Conversation identifier — populated for assistant-originated events. */
    conversationId: z.string().optional(),
    /** Itinerary identifier — populated when an itinerary is involved. */
    itineraryId: z.string().optional(),
    /** Booking identifier — populated for booking / payment events. */
    bookingId: z.string().optional(),
    /** Travel vertical for this event. */
    category: FunnelCategorySchema,
    /** Bounded primitive attributes — at most 20 keys, no nested objects. */
    attributes: FunnelAttributesSchema,
    ...piiNeverFields,
  })
  .strict(); // rejects any extra key not listed above

export type FunnelEvent = z.infer<typeof FunnelEventSchema>;

// ---------------------------------------------------------------------------
// Helper: build a FunnelEvent with defaults filled in
// ---------------------------------------------------------------------------

export function buildFunnelEvent(
  fields: Omit<FunnelEvent, "schemaVersion">,
): FunnelEvent {
  return FunnelEventSchema.parse({ ...fields, schemaVersion: 1 });
}
