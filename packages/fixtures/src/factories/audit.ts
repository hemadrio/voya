/**
 * BookingAuditLog seed factories.
 *
 * Audit rows are append-only (enforced by DB trigger). The seed populates one
 * row per state transition for the CONFIRMED flight booking so every downstream
 * audit-trail assertion has a stable reference. Actor and resource fields are
 * populated per the WO-072 additions.
 *
 * PII minimisation: previous_state and new_state are sanitised through the
 * contracts sanitiseAuditPayload() helper before persistence — this is already
 * encoded in the factory so tests don't need to re-sanitise.
 */

import { SEED_IDS, SEED_REFERENCE_INSTANT, refDate } from "../identifiers.js";

const MIN = 60 * 1000;

export interface AuditLogSeed {
  id: string;
  bookingId: string;
  action: string;
  previousState: object | null;
  newState: object | null;
  changedBy: string | null;
  timestamp: Date;
  actorId: string | null;
  actorRole: string | null;
  resourceType: string | null;
  resourceId: string | null;
  occurredAt: Date;
}

let auditCounter = 1;
function auditId(): string {
  const hex = auditCounter.toString(16).padStart(12, "0");
  auditCounter++;
  return `f0000004-0000-4000-8000-${hex}`;
}

export function makeAuditLog(overrides: Partial<AuditLogSeed> = {}): AuditLogSeed {
  return {
    id: `f0000004-0000-4000-8000-000000000001`,
    bookingId: SEED_IDS.booking.flightConfirmed,
    action: "CREATED",
    previousState: null,
    newState: { status: "PENDING" },
    changedBy: SEED_IDS.user.alice,
    timestamp: SEED_REFERENCE_INSTANT,
    actorId: SEED_IDS.user.alice,
    actorRole: "traveler",
    resourceType: "booking",
    resourceId: SEED_IDS.booking.flightConfirmed,
    occurredAt: SEED_REFERENCE_INSTANT,
    ...overrides,
  };
}

/**
 * State-transition audit trail for the confirmed flight booking.
 * Provides: CREATED → STATUS_CHANGED(PENDING→CONFIRMED) → PAYMENT_CONFIRMED
 */
export const SEED_AUDIT_LOGS: AuditLogSeed[] = [
  // CREATED
  makeAuditLog({
    id: auditId(),
    action: "CREATED",
    previousState: null,
    newState: { status: "PENDING" },
    occurredAt: SEED_REFERENCE_INSTANT,
    timestamp: SEED_REFERENCE_INSTANT,
  }),
  // STATUS_CHANGED: PENDING → CONFIRMED (triggered by payment webhook)
  makeAuditLog({
    id: auditId(),
    action: "STATUS_CHANGED",
    previousState: { status: "PENDING" },
    newState: { status: "CONFIRMED" },
    occurredAt: refDate(3 * MIN),
    timestamp: refDate(3 * MIN),
  }),
  // PAYMENT_CONFIRMED
  makeAuditLog({
    id: auditId(),
    action: "PAYMENT_CONFIRMED",
    previousState: null,
    newState: { paymentIntentId: "SYNTH-PI-0000000001", amount: "412.50", currency: "USD" },
    actorRole: "system",
    actorId: "payment-service",
    occurredAt: refDate(3 * MIN + 500),
    timestamp: refDate(3 * MIN + 500),
  }),

  // Audit trail for the CANCELLED booking (Charlie)
  makeAuditLog({
    id: auditId(),
    bookingId: SEED_IDS.booking.cancelled,
    action: "CREATED",
    previousState: null,
    newState: { status: "PENDING" },
    changedBy: SEED_IDS.user.charlie,
    actorId: SEED_IDS.user.charlie,
    occurredAt: refDate(-24 * 60 * MIN),
    timestamp: refDate(-24 * 60 * MIN),
    resourceId: SEED_IDS.booking.cancelled,
  }),
  makeAuditLog({
    id: auditId(),
    bookingId: SEED_IDS.booking.cancelled,
    action: "CANCELLED",
    previousState: { status: "PENDING" },
    newState: { status: "CANCELLED" },
    changedBy: SEED_IDS.user.charlie,
    actorId: SEED_IDS.user.charlie,
    occurredAt: refDate(-24 * 60 * MIN + 30 * MIN),
    timestamp: refDate(-24 * 60 * MIN + 30 * MIN),
    resourceId: SEED_IDS.booking.cancelled,
  }),
];
