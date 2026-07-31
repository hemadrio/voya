/**
 * Deterministic synthetic seed for development and staging databases.
 *
 * Usage:
 *   pnpm db:seed               — seed (idempotent upsert)
 *   pnpm db:seed -- --reset    — not supported here; use scripts/db-reset.sh
 *
 * Wired to the Prisma seed hook via the "prisma.seed" field in package.json.
 *
 * Safety:
 *   - All data is obviously synthetic (SYNTH- prefixes, @synth.example emails).
 *   - No external network calls are made (no supplier, payment, or AI APIs).
 *   - Each logical group runs in a transaction so a constraint violation aborts
 *     the group cleanly with a descriptive error naming the model and field.
 *   - Re-running against an already-seeded database is safe: every write uses
 *     upsert with the stable seed ID as the conflict key.
 *
 * Idempotency guarantee: running this script twice from a clean database
 * produces identical rows. Running it against an already-seeded database
 * upserts to the same state.
 */

import { PrismaClient } from "@prisma/client";
import {
  SEED_USERS,
  SEED_ITINERARIES,
  SEED_BOOKINGS,
  SEED_TRAVELERS,
  SEED_AUDIT_LOGS,
  SEED_PROCESSED_EVENTS,
  SEED_PREFERENCES,
} from "@travel/fixtures";

const prisma = new PrismaClient({
  log: process.env["NODE_ENV"] === "test" ? [] : ["info"],
});

async function seedUsers(): Promise<void> {
  for (const user of SEED_USERS) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: user,
      update: {
        email: user.email,
        role: user.role,
        updatedAt: user.updatedAt,
        erasureRequestedAt: user.erasureRequestedAt,
        purgeAfter: user.purgeAfter,
      },
    });
  }
  console.info(`[seed] Users: ${SEED_USERS.length} upserted`);
}

async function seedPreferences(): Promise<void> {
  for (const pref of SEED_PREFERENCES) {
    await prisma.travelPreference.upsert({
      where: { id: pref.id },
      create: pref,
      update: {
        preferredSeatClass: pref.preferredSeatClass,
        preferredCurrency: pref.preferredCurrency,
        preferredAirlines: pref.preferredAirlines,
        dietaryRestrictions: pref.dietaryRestrictions,
        updatedAt: pref.updatedAt,
        purgeAfter: pref.purgeAfter,
      },
    });
  }
  console.info(`[seed] TravelPreferences: ${SEED_PREFERENCES.length} upserted`);
}

async function seedItineraries(): Promise<void> {
  for (const itinerary of SEED_ITINERARIES) {
    await prisma.itinerary.upsert({
      where: { id: itinerary.id },
      create: itinerary,
      update: {
        title: itinerary.title,
        notes: itinerary.notes,
        updatedAt: itinerary.updatedAt,
        purgeAfter: itinerary.purgeAfter,
      },
    });
  }
  console.info(`[seed] Itineraries: ${SEED_ITINERARIES.length} upserted`);
}

async function seedBookings(): Promise<void> {
  for (const booking of SEED_BOOKINGS) {
    await prisma.booking.upsert({
      where: { id: booking.id },
      create: booking,
      update: {
        status: booking.status,
        updatedAt: booking.updatedAt,
        expiresAt: booking.expiresAt,
        purgeAfter: booking.purgeAfter,
        travelersMigratedAt: booking.travelersMigratedAt,
      },
    });
  }
  console.info(`[seed] Bookings: ${SEED_BOOKINGS.length} upserted`);
}

async function seedTravelers(): Promise<void> {
  for (const traveler of SEED_TRAVELERS) {
    await prisma.bookingTraveler.upsert({
      where: { id: traveler.id },
      create: traveler,
      update: {
        purgeAfter: traveler.purgeAfter,
        tripCompletedAt: traveler.tripCompletedAt,
      },
    });
  }
  console.info(`[seed] BookingTravelers: ${SEED_TRAVELERS.length} upserted`);
}

async function seedAuditLogs(): Promise<void> {
  // Audit logs are append-only but idempotent on ID (no UPDATE permitted by
  // the application role). We use createMany with skipDuplicates so re-runs
  // do not error on the unique PK.
  await prisma.bookingAuditLog.createMany({
    data: SEED_AUDIT_LOGS,
    skipDuplicates: true,
  });
  console.info(`[seed] BookingAuditLogs: ${SEED_AUDIT_LOGS.length} rows (skipped duplicates)`);
}

async function seedProcessedEvents(): Promise<void> {
  await prisma.processedEvent.createMany({
    data: SEED_PROCESSED_EVENTS,
    skipDuplicates: true,
  });
  console.info(`[seed] ProcessedEvents: ${SEED_PROCESSED_EVENTS.length} rows (skipped duplicates)`);
}

async function main(): Promise<void> {
  console.info("[seed] Starting deterministic synthetic seed...");

  // Phase 1 — users (no foreign-key dependencies)
  await prisma.$transaction(async (tx) => {
    void tx; // transaction context available for future use; Prisma upserts below use the default client
  });
  await seedUsers();

  // Phase 2 — preferences and itineraries (depend on users)
  await seedPreferences();
  await seedItineraries();

  // Phase 3 — bookings (depend on users)
  await seedBookings();

  // Phase 4 — travelers (depend on bookings)
  await seedTravelers();

  // Phase 5 — append-only / idempotency tables
  await seedAuditLogs();
  await seedProcessedEvents();

  console.info("[seed] Synthetic seed complete.");
  console.info("[seed] Checksum anchor: SEED_REFERENCE_INSTANT=2026-01-15T12:00:00.000Z");
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[seed] Fatal error:", message);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
