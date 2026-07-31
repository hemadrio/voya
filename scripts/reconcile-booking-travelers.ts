/**
 * reconcile-booking-travelers — compares legacy passengers array length to
 * booking_travelers row count per booking.
 *
 * Emits a structured report and exits non-zero if any mismatch is found.
 * This gate must pass before the contract migration (column drop) proceeds.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/reconcile-booking-travelers.ts
 *
 * Exit codes:
 *   0 — reconciliation passed (counts match for all bookings)
 *   1 — reconciliation failed (mismatches found or fatal error)
 */

import { PrismaClient } from "@prisma/client";
import {
  buildReconciliationReport,
  type BookingCountRow,
} from "../services/booking-service/src/domain/ReconciliationComparator.js";

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function collectCounts(prisma: PrismaClient): Promise<BookingCountRow[]> {
  const BATCH_SIZE = 200;
  const rows: BookingCountRow[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    const bookings = await prisma.booking.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: {
        id: true,
        passengers: true,
        _count: { select: { travelers: true } },
      },
    });

    if (bookings.length === 0) break;

    cursor = bookings[bookings.length - 1]?.id;

    for (const booking of bookings) {
      const passengers = Array.isArray(booking.passengers)
        ? (booking.passengers as unknown[]).length
        : 0;

      rows.push({
        bookingId: booking.id,
        passengersArrayLength: passengers,
        travelersRowCount: booking._count.travelers,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// CloudWatch metric emission (best-effort)
// ---------------------------------------------------------------------------

async function emitCloudWatchMetric(mismatchCount: number): Promise<void> {
  try {
    const { CloudWatchClient, PutMetricDataCommand } = await import(
      "@aws-sdk/client-cloudwatch"
    );
    const cw = new CloudWatchClient({});
    await cw.send(
      new PutMetricDataCommand({
        Namespace: "TravelPlatform/Backfill",
        MetricData: [
          {
            MetricName: "BookingTravelerReconciliationMismatches",
            Value: mismatchCount,
            Unit: "Count",
            Dimensions: [
              {
                Name: "Environment",
                Value: process.env["NODE_ENV"] ?? "unknown",
              },
            ],
          },
        ],
      }),
    );
    console.log(`[reconcile] CloudWatch metric emitted: mismatches=${mismatchCount}`);
  } catch {
    console.warn("[reconcile] Failed to emit CloudWatch metric (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[reconcile] Starting booking_travelers reconciliation...");

  const prisma = new PrismaClient();

  let rows: BookingCountRow[];
  try {
    rows = await collectCounts(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const report = buildReconciliationReport(rows);

  console.log("[reconcile] Report:");
  console.log(JSON.stringify(report, null, 2));

  await emitCloudWatchMetric(report.mismatches.length);

  if (!report.passed) {
    console.error(
      `[reconcile] FAIL — ${report.mismatches.length} mismatch(es) found. ` +
        `Resolve before proceeding to contract migration.`,
    );
    process.exit(1);
  }

  console.log(
    `[reconcile] PASS — all ${report.totalBookings} bookings reconciled (${report.totalMatched} matched).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[reconcile] Fatal error:", err);
  process.exit(1);
});
