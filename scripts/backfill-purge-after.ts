/**
 * backfill-purge-after — populate purge_after on existing rows.
 *
 * Iterates every personal-data table in cursor-batched, idempotent passes.
 * Rows that already have purge_after set are skipped.
 * Rows where the derivation returns null (e.g. trip not yet completed)
 * are counted but not updated — they should be re-evaluated by a scheduled job.
 *
 * Idempotency: WHERE purge_after IS NULL guard ensures re-runs are safe.
 * Resumability: cursor on primary key; process can be killed and restarted.
 *
 * Security constraint: retention durations come from environment config,
 * not from literals. The script refuses to start if any config key is absent.
 *
 * Usage:
 *   RETENTION_ACCOUNT_IDENTITY_DAYS=30 \
 *   RETENTION_TRANSACTION_YEARS=7 \
 *   RETENTION_IDENTITY_DOCUMENT_DAYS=90 \
 *   RETENTION_SESSION_DAYS=7 \
 *   RETENTION_ITINERARY_YEARS=7 \
 *   RETENTION_PREFERENCE_DAYS=365 \
 *   RETENTION_CONVERSATION_DAYS=90 \
 *   RETENTION_AUDIT_DAYS=365 \
 *   BATCH_SIZE=500 DRY_RUN=false \
 *   DATABASE_URL=postgres://... tsx scripts/backfill-purge-after.ts
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { loadRetentionConfig } from "@travel/retention";
import {
  deriveAccountIdentityPurgeAfter,
  deriveSessionPurgeAfter,
  deriveOneTimeTokenPurgeAfter,
  deriveBookingPurgeAfter,
  deriveTravelerIdentityPurgeAfter,
  deriveItineraryPurgeAfter,
  derivePreferencePurgeAfter,
} from "@travel/retention";

// ---------------------------------------------------------------------------
// Configuration — fail fast if retention config is incomplete
// ---------------------------------------------------------------------------

const config = loadRetentionConfig(); // throws with named missing keys

const BATCH_SIZE = parseInt(process.env["BATCH_SIZE"] ?? "500", 10);
const DRY_RUN = process.env["DRY_RUN"] !== "false";

if (DRY_RUN) {
  console.warn("[backfill-purge-after] DRY_RUN=true — no writes will be made");
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

interface TableStats {
  processed: number;
  updated: number;
  skippedNullDerivation: number;
  alreadySet: number;
}

function emptyStats(): TableStats {
  return { processed: 0, updated: 0, skippedNullDerivation: 0, alreadySet: 0 };
}

// ---------------------------------------------------------------------------
// Generic cursor-based updater
// ---------------------------------------------------------------------------

type CursorId = string;

async function backfillTable<TRow extends { id: string }>(opts: {
  tableName: string;
  findBatch: (cursor: CursorId | null, batchSize: number) => Promise<TRow[]>;
  derive: (row: TRow) => Date | null;
  update: (id: string, purgeAfter: Date) => Promise<void>;
  countAlreadySet: () => Promise<number>;
}): Promise<TableStats> {
  const stats = emptyStats();
  stats.alreadySet = await opts.countAlreadySet();

  console.log(`[${opts.tableName}] starting — already-set: ${stats.alreadySet}`);

  let cursor: CursorId | null = null;

  while (true) {
    const batch = await opts.findBatch(cursor, BATCH_SIZE);
    if (batch.length === 0) break;

    cursor = batch[batch.length - 1]!.id;
    stats.processed += batch.length;

    for (const row of batch) {
      const purgeAfter = opts.derive(row);
      if (purgeAfter === null) {
        stats.skippedNullDerivation++;
        continue;
      }
      if (!DRY_RUN) {
        await opts.update(row.id, purgeAfter);
      }
      stats.updated++;
    }

    console.log(
      `[${opts.tableName}] processed=${stats.processed} updated=${stats.updated} ` +
        `null=${stats.skippedNullDerivation} cursor=${cursor}`,
    );
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-table backfill logic
// ---------------------------------------------------------------------------

async function backfillUsers(): Promise<TableStats> {
  return backfillTable({
    tableName: "users",
    findBatch: async (cursor, batchSize) => {
      return prisma.user.findMany({
        where: {
          purgeAfter: null,
          erasureRequestedAt: { not: null },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, erasureRequestedAt: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    },
    derive: (row) => deriveAccountIdentityPurgeAfter(row.erasureRequestedAt, config),
    update: async (id, purgeAfter) => {
      await prisma.user.update({ where: { id }, data: { purgeAfter } });
    },
    countAlreadySet: async () =>
      prisma.user.count({ where: { purgeAfter: { not: null } } }),
  });
}

async function backfillSessions(): Promise<TableStats> {
  return backfillTable({
    tableName: "sessions",
    findBatch: async (cursor, batchSize) => {
      return prisma.session.findMany({
        where: {
          purgeAfter: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, expiresAt: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    },
    derive: (row) => deriveSessionPurgeAfter(row.expiresAt, config),
    update: async (id, purgeAfter) => {
      await prisma.session.update({ where: { id }, data: { purgeAfter } });
    },
    countAlreadySet: async () =>
      prisma.session.count({ where: { purgeAfter: { not: null } } }),
  });
}

async function backfillOneTimeTokens(): Promise<TableStats> {
  return backfillTable({
    tableName: "one_time_tokens",
    findBatch: async (cursor, batchSize) => {
      return prisma.oneTimeToken.findMany({
        where: {
          purgeAfter: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, expiresAt: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    },
    derive: (row) => deriveOneTimeTokenPurgeAfter(row.expiresAt, config),
    update: async (id, purgeAfter) => {
      await prisma.oneTimeToken.update({ where: { id }, data: { purgeAfter } });
    },
    countAlreadySet: async () =>
      prisma.oneTimeToken.count({ where: { purgeAfter: { not: null } } }),
  });
}

async function backfillBookings(): Promise<TableStats> {
  return backfillTable({
    tableName: "bookings",
    findBatch: async (cursor, batchSize) => {
      return prisma.booking.findMany({
        where: {
          purgeAfter: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, createdAt: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    },
    derive: (row) => deriveBookingPurgeAfter(row.createdAt, config),
    update: async (id, purgeAfter) => {
      await prisma.booking.update({ where: { id }, data: { purgeAfter } });
    },
    countAlreadySet: async () =>
      prisma.booking.count({ where: { purgeAfter: { not: null } } }),
  });
}

async function backfillBookingTravelers(): Promise<TableStats> {
  return backfillTable({
    tableName: "booking_travelers",
    findBatch: async (cursor, batchSize) => {
      return prisma.bookingTraveler.findMany({
        where: {
          purgeAfter: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, tripCompletedAt: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    },
    derive: (row) => deriveTravelerIdentityPurgeAfter(row.tripCompletedAt, config),
    update: async (id, purgeAfter) => {
      await prisma.bookingTraveler.update({ where: { id }, data: { purgeAfter } });
    },
    countAlreadySet: async () =>
      prisma.bookingTraveler.count({ where: { purgeAfter: { not: null } } }),
  });
}

async function backfillItineraries(): Promise<TableStats> {
  return backfillTable({
    tableName: "itineraries",
    findBatch: async (cursor, batchSize) => {
      return prisma.itinerary.findMany({
        where: {
          purgeAfter: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, createdAt: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    },
    derive: (row) => deriveItineraryPurgeAfter(row.createdAt, config),
    update: async (id, purgeAfter) => {
      await prisma.itinerary.update({ where: { id }, data: { purgeAfter } });
    },
    countAlreadySet: async () =>
      prisma.itinerary.count({ where: { purgeAfter: { not: null } } }),
  });
}

async function backfillTravelPreferences(): Promise<TableStats> {
  return backfillTable({
    tableName: "travel_preferences",
    findBatch: async (cursor, batchSize) => {
      return prisma.travelPreference.findMany({
        where: {
          purgeAfter: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
    },
    derive: (row) => derivePreferencePurgeAfter(row.updatedAt, config),
    update: async (id, purgeAfter) => {
      await prisma.travelPreference.update({ where: { id }, data: { purgeAfter } });
    },
    countAlreadySet: async () =>
      prisma.travelPreference.count({ where: { purgeAfter: { not: null } } }),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[backfill-purge-after] starting — batch_size=%d dry_run=%s", BATCH_SIZE, DRY_RUN);

  const results: Record<string, TableStats> = {};

  results["users"] = await backfillUsers();
  results["sessions"] = await backfillSessions();
  results["one_time_tokens"] = await backfillOneTimeTokens();
  results["bookings"] = await backfillBookings();
  results["booking_travelers"] = await backfillBookingTravelers();
  results["itineraries"] = await backfillItineraries();
  results["travel_preferences"] = await backfillTravelPreferences();

  console.log("\n[backfill-purge-after] summary:");

  let totalUpdated = 0;
  let totalNullDerivation = 0;

  for (const [table, stats] of Object.entries(results)) {
    console.log(
      "  %-25s processed=%-6d updated=%-6d null=%-6d already_set=%d",
      table,
      stats.processed,
      stats.updated,
      stats.skippedNullDerivation,
      stats.alreadySet,
    );
    totalUpdated += stats.updated;
    totalNullDerivation += stats.skippedNullDerivation;
  }

  console.log("\n[backfill-purge-after] total_updated=%d null_derivation=%d", totalUpdated, totalNullDerivation);

  if (totalNullDerivation > 0) {
    console.warn(
      "[backfill-purge-after] %d rows have null derivation (trip not yet completed / " +
        "no erasure request). They will be skipped by the purge job until " +
        "the anchor date is populated.",
      totalNullDerivation,
    );
  }

  if (DRY_RUN) {
    console.warn("[backfill-purge-after] DRY_RUN=true — above counts are simulated, no writes made");
  }
}

main()
  .catch((err) => {
    console.error("[backfill-purge-after] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
