/**
 * Trip document send test fixtures (WO-055, AC12).
 *
 * Three fixture itineraries:
 *   FIXTURE_ITINERARY_OWNED_CONFIRMED   — owned, has ≥1 CONFIRMED booking
 *   FIXTURE_ITINERARY_OWNED_PENDING_ONLY — owned, only PENDING bookings
 *   FIXTURE_ITINERARY_OTHER_USER        — itinerary owned by a different user
 *
 * All IDs and personal data are synthetic (SYNTH-* prefix or UUID offsets).
 * NEVER use real or production-derived data.
 */

import type {
  TripDocumentDeliveryRepositoryPort,
  UserEmailRepositoryPort,
  ItineraryBookingStatusRow,
} from "../../src/domain/TripDocumentDeliveryService.js";
import type { AuditTxClient } from "../../src/domain/AuditWriter.js";
import type { QueuePort } from "@travel/queue";
import type { SecurityEventWriter } from "../../src/domain/SecurityEventWriter.js";

// ---------------------------------------------------------------------------
// Synthetic IDs
// ---------------------------------------------------------------------------

export const SYNTH_OWNER_USER_ID = "a0000001-0000-4000-8000-000000000001";
export const SYNTH_OTHER_USER_ID = "a0000001-0000-4000-8000-000000000002";

export const SYNTH_ITINERARY_CONFIRMED_ID = "b0000001-0000-4000-8000-000000000001";
export const SYNTH_ITINERARY_PENDING_ONLY_ID = "b0000001-0000-4000-8000-000000000002";
export const SYNTH_ITINERARY_OTHER_USER_ID = "b0000001-0000-4000-8000-000000000003";

export const SYNTH_VERIFIED_EMAIL = "synth-traveler@example.invalid";
export const SYNTH_CORRELATION_ID = "corr-synth-00000001";

// ---------------------------------------------------------------------------
// Booking status fixtures
// ---------------------------------------------------------------------------

export const BOOKINGS_ONE_CONFIRMED: ItineraryBookingStatusRow[] = [
  { status: "CONFIRMED" },
  { status: "PENDING" },
];

export const BOOKINGS_PENDING_ONLY: ItineraryBookingStatusRow[] = [
  { status: "PENDING" },
  { status: "PENDING" },
];

// ---------------------------------------------------------------------------
// Mock AuditTxClient
// ---------------------------------------------------------------------------

export function makeMockAuditTxClient(): {
  client: AuditTxClient;
  rows: Array<{ data: Record<string, unknown> }>;
} {
  const rows: Array<{ data: Record<string, unknown> }> = [];
  const client: AuditTxClient = {
    bookingAuditLog: {
      create: async (args) => {
        rows.push({ data: args.data as Record<string, unknown> });
        return {};
      },
    },
  };
  return { client, rows };
}

// ---------------------------------------------------------------------------
// Mock TripDocumentDeliveryRepositoryPort
// ---------------------------------------------------------------------------

export interface MockDeliveryRepo {
  repo: TripDocumentDeliveryRepositoryPort;
  auditRows: Array<{ data: Record<string, unknown> }>;
}

/**
 * Build a mock delivery repository.
 *
 * @param scenario - "confirmed" | "pending-only" | "other-user" | "not-found"
 */
export function makeMockDeliveryRepo(
  scenario: "confirmed" | "pending-only" | "other-user" | "not-found",
): MockDeliveryRepo {
  const { client: auditTxClient, rows: auditRows } = makeMockAuditTxClient();

  let itineraryRow: { id: string; userId: string } | null = null;
  let bookingStatuses: ItineraryBookingStatusRow[] = [];

  switch (scenario) {
    case "confirmed":
      itineraryRow = { id: SYNTH_ITINERARY_CONFIRMED_ID, userId: SYNTH_OWNER_USER_ID };
      bookingStatuses = BOOKINGS_ONE_CONFIRMED;
      break;
    case "pending-only":
      itineraryRow = { id: SYNTH_ITINERARY_PENDING_ONLY_ID, userId: SYNTH_OWNER_USER_ID };
      bookingStatuses = BOOKINGS_PENDING_ONLY;
      break;
    case "other-user":
      itineraryRow = { id: SYNTH_ITINERARY_OTHER_USER_ID, userId: SYNTH_OTHER_USER_ID };
      bookingStatuses = BOOKINGS_ONE_CONFIRMED;
      break;
    case "not-found":
      itineraryRow = null;
      bookingStatuses = [];
      break;
  }

  const repo: TripDocumentDeliveryRepositoryPort = {
    findItineraryById: async () => itineraryRow,
    findItineraryBookingStatuses: async () => bookingStatuses,
    auditTxClient,
  };

  return { repo, auditRows };
}

// ---------------------------------------------------------------------------
// Mock UserEmailRepositoryPort
// ---------------------------------------------------------------------------

export function makeMockUserEmailRepo(opts?: {
  email?: string;
  emailVerified?: boolean;
  missing?: boolean;
}): UserEmailRepositoryPort {
  const email = opts?.email ?? SYNTH_VERIFIED_EMAIL;
  const emailVerified = opts?.emailVerified ?? true;
  const missing = opts?.missing ?? false;

  return {
    findUserVerifiedEmail: async () => {
      if (missing) return null;
      return { email, emailVerified };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock QueuePort
// ---------------------------------------------------------------------------

export interface MockQueue {
  queue: QueuePort;
  published: Array<{ topic: string; envelope: unknown }>;
}

export function makeMockQueue(opts?: { shouldFail?: boolean }): MockQueue {
  const published: Array<{ topic: string; envelope: unknown }> = [];
  const shouldFail = opts?.shouldFail ?? false;

  const queue: QueuePort = {
    publish: async (topic, envelope) => {
      if (shouldFail) {
        throw new Error("Queue unavailable (synthetic failure)");
      }
      published.push({ topic, envelope });
    },
    subscribe: async () => {},
    isHealthy: async () => true,
    close: async () => {},
  };

  return { queue, published };
}

// ---------------------------------------------------------------------------
// Mock SecurityEventWriter
// ---------------------------------------------------------------------------

export interface MockSecurityWriter {
  writer: SecurityEventWriter;
  events: Array<Record<string, unknown>>;
}

export function makeMockSecurityWriter(): MockSecurityWriter {
  const events: Array<Record<string, unknown>> = [];
  const writer = {
    write: async (event: Record<string, unknown>) => {
      events.push(event);
    },
  } as unknown as SecurityEventWriter;

  return { writer, events };
}
