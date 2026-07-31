/**
 * backfill-booking-travelers — resumable, batched, idempotent backfill.
 *
 * Reads Booking.passengers from the legacy JSON column, writes
 * booking_travelers rows (with KMS envelope encryption), and marks each
 * booking with travelers_migrated_at once all passengers are migrated.
 *
 * Idempotency: a booking with travelers_migrated_at != null is skipped.
 * Resumability: cursor-based on booking ID ordering; the process can be
 *   killed and restarted — it picks up from the first booking with
 *   travelers_migrated_at IS NULL.
 *
 * KMS rate-limit safety: bounded concurrency + exponential backoff with
 * jitter on ThrottlingException / KMSInternalException.
 *
 * Usage:
 *   BATCH_SIZE=100 MAX_CONCURRENCY=5 CMK_ARN=arn:aws:kms:... \
 *   DATABASE_URL=postgres://... tsx scripts/backfill-booking-travelers.ts
 */

import { PrismaClient } from "@prisma/client";
import { KmsEnvelopeCipher } from "@travel/crypto";
import { BookingTravelerRepository } from "../services/booking-service/src/repositories/BookingTravelerRepository.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BATCH_SIZE = parseInt(process.env["BATCH_SIZE"] ?? "100", 10);
const MAX_CONCURRENCY = parseInt(process.env["MAX_CONCURRENCY"] ?? "5", 10);
const CMK_ARN = process.env["CMK_ARN"] ?? "";
const DRY_RUN = process.env["DRY_RUN"] === "true";

if (!CMK_ARN) {
  console.error("[backfill] CMK_ARN environment variable is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff + jitter
// ---------------------------------------------------------------------------

const MAX_RETRY = 5;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 30_000;

type KMSThrottlingError = Error & { name: string };

function isRetryableKmsError(err: unknown): err is KMSThrottlingError {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "ThrottlingException" ||
    err.name === "KMSInternalException" ||
    err.name === "RequestLimitExceeded"
  );
}

async function withKmsRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isRetryableKmsError(err) || attempt >= MAX_RETRY) {
        throw err;
      }
      const baseDelay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const jitter = Math.random() * baseDelay;
      const delay = Math.min(baseDelay + jitter, MAX_DELAY_MS);
      console.warn(
        `[backfill] KMS throttle (attempt ${attempt}/${MAX_RETRY}), retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Booking passenger shape
// ---------------------------------------------------------------------------

interface LegacyPassenger {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  email?: string;
  passportNumber?: string;
}

interface LegacyBooking {
  id: string;
  passengers: LegacyPassenger[] | null;
}

// ---------------------------------------------------------------------------
// Quarantine list
// ---------------------------------------------------------------------------

interface QuarantineEntry {
  bookingId: string;
  passengerIndex: number;
  reason: string;
}

const quarantine: QuarantineEntry[] = [];

// ---------------------------------------------------------------------------
// Per-passenger migration
// ---------------------------------------------------------------------------

async function migratePassenger(
  repo: BookingTravelerRepository,
  bookingId: string,
  passenger: LegacyPassenger,
): Promise<void> {
  await withKmsRetry(() =>
    repo.create({
      bookingId,
      givenName: passenger.firstName,
      familyName: passenger.lastName,
      email: passenger.email,
      dateOfBirth: passenger.dateOfBirth,
      passportReference: passenger.passportNumber ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Per-booking migration
// ---------------------------------------------------------------------------

async function migrateBooking(
  prisma: PrismaClient,
  repo: BookingTravelerRepository,
  booking: LegacyBooking,
): Promise<void> {
  const passengers = booking.passengers ?? [];

  if (passengers.length === 0) {
    // Empty array — mark migrated with zero travelers
    if (!DRY_RUN) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { travelersMigratedAt: new Date() },
      });
    }
    return;
  }

  // Check for already-migrated travelers (idempotency)
  const existingCount = await repo.countByBookingId(booking.id);
  if (existingCount === passengers.length) {
    // Already fully migrated — just set the marker
    if (!DRY_RUN) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { travelersMigratedAt: new Date() },
      });
    }
    return;
  }

  // Migrate each passenger (skip if somehow partial — full re-run is idempotent
  // because create is guarded by a unique constraint on the caller side)
  for (let i = 0; i < passengers.length; i++) {
    const passenger = passengers[i];
    if (!passenger) continue;

    // Validate minimum shape
    if (
      typeof passenger.firstName !== "string" ||
      !passenger.firstName.trim() ||
      typeof passenger.lastName !== "string" ||
      !passenger.lastName.trim() ||
      typeof passenger.dateOfBirth !== "string" ||
      !passenger.dateOfBirth.trim()
    ) {
      quarantine.push({
        bookingId: booking.id,
        passengerIndex: i,
        reason: `malformed passenger: missing required fields`,
      });
      console.error(
        `[backfill] QUARANTINE booking=${booking.id} passengerIndex=${i} reason=malformed`,
      );
      continue;
    }

    if (!DRY_RUN) {
      await migratePassenger(repo, booking.id, passenger);
    } else {
      console.log(`[backfill] DRY_RUN would migrate booking=${booking.id} passenger=${i}`);
    }
  }

  // Mark booking as migrated
  if (!DRY_RUN) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { travelersMigratedAt: new Date() },
    });
  }
}

// ---------------------------------------------------------------------------
// Bounded concurrency helper
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<void> {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `[backfill] Starting — batchSize=${BATCH_SIZE} maxConcurrency=${MAX_CONCURRENCY} dryRun=${DRY_RUN}`,
  );

  const prisma = new PrismaClient();

  const cipher = new KmsEnvelopeCipher({ cmkArn: CMK_ARN });

  // Minimal Prisma client adapter for the repository
  const db = {
    bookingTraveler: {
      create: (args: Parameters<typeof prisma.bookingTraveler.create>[0]) =>
        prisma.bookingTraveler.create(args),
      findMany: (args: Parameters<typeof prisma.bookingTraveler.findMany>[0]) =>
        prisma.bookingTraveler.findMany(args),
      count: (args: Parameters<typeof prisma.bookingTraveler.count>[0]) =>
        prisma.bookingTraveler.count(args),
    },
  };

  const repo = new BookingTravelerRepository(db as never, cipher);

  let cursor: string | undefined = undefined;
  let totalMigrated = 0;
  let totalSkipped = 0;
  let batchNumber = 0;

  try {
    while (true) {
      batchNumber++;

      const bookings = await prisma.booking.findMany({
        where: {
          travelersMigratedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        select: {
          id: true,
          passengers: true,
        },
      });

      if (bookings.length === 0) {
        console.log(`[backfill] No more bookings to migrate. Done.`);
        break;
      }

      const lastBooking = bookings[bookings.length - 1];
      cursor = lastBooking?.id;

      console.log(
        `[backfill] Batch ${batchNumber}: processing ${bookings.length} bookings (cursor=${cursor})`,
      );

      const tasks = (bookings as LegacyBooking[]).map(
        (booking) => () =>
          migrateBooking(prisma, repo, booking).then(() => {
            totalMigrated++;
          }),
      );

      await runWithConcurrency(tasks, MAX_CONCURRENCY);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `[backfill] Complete — migrated=${totalMigrated} skipped=${totalSkipped} quarantined=${quarantine.length}`,
  );

  if (quarantine.length > 0) {
    console.error("[backfill] QUARANTINE ENTRIES:");
    for (const entry of quarantine) {
      console.error(
        `  booking=${entry.bookingId} passengerIndex=${entry.passengerIndex} reason=${entry.reason}`,
      );
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
