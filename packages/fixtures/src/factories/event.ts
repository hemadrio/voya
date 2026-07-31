/**
 * ProcessedEvent seed factories.
 *
 * Two rows: one Stripe webhook event and one notification consumer event.
 * The test suite verifies that a second INSERT with the same (provider, eventId)
 * produces a P2002 unique-constraint violation — the seed row is the "first
 * delivery" anchor.
 *
 * payload_digest is a 64-character hex SHA-256. We use a precomputed
 * synthetic value (all zeroes with a meaningful prefix) so the digest is
 * stable across runs without executing crypto at import time.
 */

import { SEED_IDS, SEED_REFERENCE_INSTANT, refDate } from "../identifiers.js";

const MIN = 60 * 1000;

export interface ProcessedEventSeed {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  payloadDigest: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export function makeProcessedEvent(overrides: Partial<ProcessedEventSeed> = {}): ProcessedEventSeed {
  return {
    id: SEED_IDS.processedEvent.stripePaymentSuccess,
    provider: "stripe",
    eventId: "SYNTH-EVT-stripe-pi-succeeded-0001",
    eventType: "payment_intent.succeeded",
    payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    receivedAt: SEED_REFERENCE_INSTANT,
    processedAt: refDate(2 * MIN),
    ...overrides,
  };
}

/**
 * Seed rows for the exactly-once idempotency store.
 *
 * The duplicate-event scenario is NOT seeded as a second row (that would
 * violate the unique constraint). Instead, the integration test demonstrates
 * the constraint by attempting a second INSERT after the seed — the seed
 * provides only the "first delivery" row, leaving the constraint violation
 * reproducible in isolation.
 */
export const SEED_PROCESSED_EVENTS: ProcessedEventSeed[] = [
  makeProcessedEvent(),
  makeProcessedEvent({
    id: SEED_IDS.processedEvent.notificationDelivered,
    provider: "notification-service",
    eventId: "SYNTH-EVT-notification-booking-conf-0001",
    eventType: "booking.confirmation.sent",
    payloadDigest: "1111111111111111111111111111111111111111111111111111111111111111",
    receivedAt: refDate(5 * MIN),
    processedAt: refDate(6 * MIN),
  }),
];

/** The eventId of the pre-seeded Stripe event — use this in duplicate-event tests. */
export const DUPLICATE_EVENT_SCENARIO = {
  provider: "stripe",
  eventId: "SYNTH-EVT-stripe-pi-succeeded-0001",
  eventType: "payment_intent.succeeded",
  payloadDigest: "2222222222222222222222222222222222222222222222222222222222222222",
} as const;
