/**
 * Integration test — seeds a clean database and asserts row counts,
 * referential integrity, and the presence of each special case.
 *
 * Runs against the local Docker Compose stack. Set DATABASE_URL before
 * running:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/travel_dev \
 *     pnpm test:integration
 *
 * Skipped automatically when DATABASE_URL is unset or points to a
 * non-local host (to avoid running in environments without a live DB).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  SEED_BOOKINGS,
  SEED_USERS,
  SEED_ITINERARIES,
  SEED_TRAVELERS,
  SEED_AUDIT_LOGS,
  SEED_PROCESSED_EVENTS,
  SEED_PREFERENCES,
  SEED_IDS,
  SEED_REFERENCE_INSTANT,
  DUPLICATE_EVENT_SCENARIO,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Guard: only run when DATABASE_URL is set and points to a local/staging host
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const isLocalOrStaging =
  DATABASE_URL.includes("localhost") ||
  DATABASE_URL.includes("127.0.0.1") ||
  DATABASE_URL.includes(".staging.internal") ||
  DATABASE_URL.includes("staging-travel-platform.");

const SKIP_INTEGRATION = !DATABASE_URL || !isLocalOrStaging;

// Conditional describe — skipped entirely when no live DB is available.
const describeIntegration = SKIP_INTEGRATION
  ? describe.skip
  : describe;

describeIntegration("Seed integration — live database assertions", () => {
  // Dynamic import of Prisma client so the test file can be imported without
  // @prisma/client installed (e.g. in CI typecheck-only runs).
  let prisma: Awaited<ReturnType<typeof getPrismaClient>>;

  async function getPrismaClient() {
    const { PrismaClient } = await import("@prisma/client");
    return new PrismaClient({ log: [] });
  }

  beforeAll(async () => {
    prisma = await getPrismaClient();
  });

  // ---------------------------------------------------------------------------
  // Row count assertions
  // ---------------------------------------------------------------------------

  it("users table has the expected seed count", async () => {
    const count = await prisma.user.count({
      where: { id: { in: Object.values(SEED_IDS.user) } },
    });
    expect(count).toBe(SEED_USERS.length);
  });

  it("bookings table covers all lifecycle states", async () => {
    const statuses = await prisma.booking.findMany({
      where: { id: { in: Object.values(SEED_IDS.booking) } },
      select: { status: true },
    });
    const statusSet = new Set(statuses.map((b) => b.status));
    for (const expected of ["PENDING", "CONFIRMED", "CANCELLED", "FAILED", "REFUNDED", "EXPIRED"]) {
      expect(statusSet, `missing status ${expected}`).toContain(expected);
    }
  });

  it("includes a PENDING booking past its expiry window", async () => {
    const expired = await prisma.booking.findFirst({
      where: {
        id: SEED_IDS.booking.pendingPastExpiry,
        status: "PENDING",
        expiresAt: { lt: SEED_REFERENCE_INSTANT },
      },
    });
    expect(expired).not.toBeNull();
  });

  it("includes an ILLUSTRATIVE (non-bookable) offer booking", async () => {
    const illustrative = await prisma.booking.findFirst({
      where: { id: SEED_IDS.booking.illustrativeOffer, bookable: false },
    });
    expect(illustrative).not.toBeNull();
    expect(illustrative?.provenance).toBe("ILLUSTRATIVE");
  });

  it("all personal-data rows have purgeAfter populated", async () => {
    const bookingsWithoutPurge = await prisma.booking.count({
      where: {
        id: { in: [SEED_IDS.booking.flightConfirmed, SEED_IDS.booking.hotelConfirmed] },
        purgeAfter: null,
      },
    });
    expect(bookingsWithoutPurge).toBe(0);
  });

  it("audit logs exist for the confirmed flight booking", async () => {
    const count = await prisma.bookingAuditLog.count({
      where: { bookingId: SEED_IDS.booking.flightConfirmed },
    });
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("processed events table has idempotency anchor rows", async () => {
    const count = await prisma.processedEvent.count({
      where: { id: { in: Object.values(SEED_IDS.processedEvent) } },
    });
    expect(count).toBe(SEED_PROCESSED_EVENTS.length);
  });

  // ---------------------------------------------------------------------------
  // Duplicate-event scenario (exactly-once constraint)
  // ---------------------------------------------------------------------------

  it("inserting a duplicate processed event violates the unique constraint", async () => {
    await expect(
      prisma.processedEvent.create({
        data: {
          id: "f0000003-0000-4000-8000-999999999999",
          provider: DUPLICATE_EVENT_SCENARIO.provider,
          eventId: DUPLICATE_EVENT_SCENARIO.eventId,
          eventType: DUPLICATE_EVENT_SCENARIO.eventType,
          payloadDigest: DUPLICATE_EVENT_SCENARIO.payloadDigest,
          receivedAt: new Date(),
        },
      })
    ).rejects.toThrow(); // Prisma P2002
  });

  // ---------------------------------------------------------------------------
  // Referential integrity
  // ---------------------------------------------------------------------------

  it("every booking traveler references a valid booking", async () => {
    const travelers = await prisma.bookingTraveler.findMany({
      where: { id: { in: Object.values(SEED_IDS.traveler) } },
      include: { booking: { select: { id: true } } },
    });
    for (const t of travelers) {
      expect(t.booking, `traveler ${t.id} has no parent booking`).not.toBeNull();
    }
  });

  it("every itinerary references a valid user", async () => {
    const itineraries = await prisma.itinerary.findMany({
      where: { id: { in: Object.values(SEED_IDS.itinerary) } },
      include: { user: { select: { id: true } } },
    });
    expect(itineraries).toHaveLength(SEED_ITINERARIES.length);
    for (const i of itineraries) {
      expect(i.user).not.toBeNull();
    }
  });

  it("Bob's travel preferences are seeded", async () => {
    const pref = await prisma.travelPreference.findUnique({
      where: { id: SEED_IDS.preference.bob },
    });
    expect(pref).not.toBeNull();
    expect(pref?.preferredSeatClass).toBe("BUSINESS");
  });
});
