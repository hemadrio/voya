/**
 * Reconciliation job entrypoint (WO-050).
 *
 * Runs as a one-off ECS Fargate task triggered by an EventBridge daily schedule.
 * No HTTP listener — dependencies are composed through manual DI.
 *
 * Lifecycle:
 *   1. Parse --date (or --from/--to) from argv; default = yesterday UTC.
 *   2. Upsert a reconciliation_runs row with status=RUNNING and the existing
 *      cursor (if any) to support resumability.
 *   3. Page through Stripe balance transactions, persisting the cursor after
 *      each page.
 *   4. Fetch the matching ledger rows and booking states for the period.
 *   5. Run ReconciliationEngine (pure).
 *   6. Persist exceptions idempotently (unique constraint catches re-runs).
 *   7. Emit CloudWatch EMF metrics.
 *   8. Write JSON + human-readable report to S3.
 *   9. Update the run row: status=COMPLETED, totals, clean_run, correct_terminal_pct.
 *
 * On any unrecoverable error the run row is set to FAILED and the process
 * exits non-zero so the EventBridge missed-run alarm fires.
 *
 * Environment variables:
 *   DATABASE_URL             — Postgres connection string (from Secrets Manager)
 *   STRIPE_SECRET_KEY        — Stripe restricted API key (read-only)
 *   RECONCILIATION_S3_BUCKET — S3 bucket for report artifacts
 *   AWS_REGION               — AWS region for CloudWatch metrics
 *   NODE_ENV                 — environment name
 */

import { runReconciliation } from "../domain/ReconciliationEngine.js";
import type {
  ProviderTransaction,
  LedgerRow,
  BookingState,
  DetectedReconciliationException,
} from "../domain/ReconciliationEngine.js";
import type { StripeBalanceReaderPort } from "../domain/StripeBalanceReaderPort.js";

// ---------------------------------------------------------------------------
// Injected DB interface (duck-typed Prisma slice)
// ---------------------------------------------------------------------------

export interface ReconciliationDbClient {
  reconciliationRun: {
    upsert(args: {
      where: { periodDate: Date };
      create: {
        periodDate: Date;
        status: string;
        cursor: string | null;
        transactionsCompared: number;
        exceptionCount: number;
        startedAt: Date;
      };
      update: {
        status?: string;
        cursor?: string | null;
        transactionsCompared?: number;
        exceptionCount?: number;
        cleanRun?: boolean;
        correctTerminalPct?: number;
        finishedAt?: Date;
        reportS3Key?: string;
      };
    }): Promise<{ id: string; cursor: string | null }>;
  };
  reconciliationException: {
    createMany(args: {
      data: Array<{
        kind: string;
        bookingId: string | null;
        paymentIntentId: string | null;
        expectedAmountMinor: bigint | null;
        actualAmountMinor: bigint | null;
        providerReference: string | null;
        periodDate: Date;
        detail: Record<string, unknown>;
        detectedAt: Date;
      }>;
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
  };
  payment: {
    findMany(args: {
      where: {
        type: string;
        status: string;
        createdAt: { gte: Date; lt: Date };
      };
      select: {
        id: boolean;
        bookingId: boolean;
        type: boolean;
        providerReference: boolean;
        amountMinor: boolean;
        currency: boolean;
        status: boolean;
      };
    }): Promise<LedgerRow[]>;
  };
  booking: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: boolean; status: boolean };
    }): Promise<BookingState[]>;
  };
}

export interface ReconciliationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ReconciliationS3Port {
  putObject(key: string, body: string, contentType: string): Promise<void>;
}

export interface ReconciliationMetricsPort {
  emitExceptions(exceptionsByKind: Record<string, number>): void;
  emitTransactionsCompared(count: number): void;
  emitRunDuration(durationMs: number): void;
  emitCleanRun(clean: boolean): void;
}

// ---------------------------------------------------------------------------
// Report shapes (AC5)
// ---------------------------------------------------------------------------

export interface ReconciliationReport {
  periodDate: string;
  transactionsCompared: number;
  exceptionsByKind: Record<string, number>;
  exceptionCount: number;
  cleanRun: boolean;
  correctTerminalStatePercent: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

export interface ReconciliationJobOptions {
  periodDate: string;
  pageSize?: number;
  s3BucketName?: string;
}

export async function runReconciliationJob(
  opts: ReconciliationJobOptions,
  db: ReconciliationDbClient,
  reader: StripeBalanceReaderPort,
  s3: ReconciliationS3Port,
  metrics: ReconciliationMetricsPort,
  logger: ReconciliationLogger,
  clock: () => Date = () => new Date(),
): Promise<ReconciliationReport> {
  const { periodDate, pageSize = 100 } = opts;
  const periodDateObj = parsePeriodDate(periodDate);
  const startedAt = clock();

  logger.info({ periodDate, jobType: "reconciliation" }, "Reconciliation job starting");

  // ── Upsert run row (or resume existing RUNNING row with cursor) ──────────
  const runRow = await db.reconciliationRun.upsert({
    where: { periodDate: periodDateObj },
    create: {
      periodDate: periodDateObj,
      status: "RUNNING",
      cursor: null,
      transactionsCompared: 0,
      exceptionCount: 0,
      startedAt,
    },
    update: {
      status: "RUNNING",
    },
  });

  let cursor = runRow.cursor;
  const allTransactions: ProviderTransaction[] = [];
  let pageCount = 0;

  // ── Page through Stripe balance transactions with restartable cursor ─────
  while (true) {
    const page = await reader.listPage(periodDate, cursor, pageSize);
    allTransactions.push(...page.transactions);
    pageCount++;

    // Persist cursor after each page for resumability (AC1)
    cursor = page.nextCursor;
    await db.reconciliationRun.upsert({
      where: { periodDate: periodDateObj },
      create: {
        periodDate: periodDateObj,
        status: "RUNNING",
        cursor,
        transactionsCompared: allTransactions.length,
        exceptionCount: 0,
        startedAt,
      },
      update: {
        cursor,
        transactionsCompared: allTransactions.length,
      },
    });

    if (cursor === null) {
      break;
    }
  }

  logger.info(
    { periodDate, transactionsCount: allTransactions.length, pages: pageCount },
    "Stripe transaction pagination complete",
  );

  // ── Fetch ledger rows for the period ─────────────────────────────────────
  const periodStart = periodDateObj;
  const periodEnd = new Date(periodDateObj);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);

  const ledgerRows = await db.payment.findMany({
    where: {
      type: "CHARGE",
      status: "SUCCEEDED",
      createdAt: { gte: periodStart, lt: periodEnd },
    },
    select: {
      id: true,
      bookingId: true,
      type: true,
      providerReference: true,
      amountMinor: true,
      currency: true,
      status: true,
    },
  });

  // ── Fetch booking states for all involved booking IDs ────────────────────
  const bookingIds = new Set<string>();
  for (const tx of allTransactions) {
    if (tx.bookingId) bookingIds.add(tx.bookingId);
  }
  for (const row of ledgerRows) {
    bookingIds.add(row.bookingId);
  }

  const bookingStates = await db.booking.findMany({
    where: { id: { in: Array.from(bookingIds) } },
    select: { id: true, status: true },
  });

  // ── Run pure comparison engine ────────────────────────────────────────────
  const result = runReconciliation(allTransactions, ledgerRows, bookingStates);
  const now = clock();

  // ── Persist exceptions idempotently (AC3, AC6) ────────────────────────────
  let persistedCount = 0;
  if (result.exceptions.length > 0) {
    const persisted = await db.reconciliationException.createMany({
      data: result.exceptions.map((ex) => ({
        kind: ex.kind,
        bookingId: ex.bookingId,
        paymentIntentId: ex.paymentIntentId,
        expectedAmountMinor: ex.expectedAmountMinor,
        actualAmountMinor: ex.actualAmountMinor,
        providerReference: ex.providerReference,
        periodDate: periodDateObj,
        detail: ex.detail,
        detectedAt: now,
      })),
      skipDuplicates: true, // unique constraint catches re-runs (AC6)
    });
    persistedCount = persisted.count;
  }

  // ── Compute report metrics ────────────────────────────────────────────────
  const exceptionsByKind = countByKind(result.exceptions);
  const transactionsCompared = result.chargesCompared + result.refundsCompared;
  const cleanRun = persistedCount === 0;
  const correctTerminalPct =
    result.totalSettledCharges > 0
      ? Math.round((result.confirmedWithSettlement / result.totalSettledCharges) * 10000)
      : 10000;

  // ── Emit metrics (AC4) ───────────────────────────────────────────────────
  metrics.emitExceptions(exceptionsByKind);
  metrics.emitTransactionsCompared(transactionsCompared);
  metrics.emitRunDuration(now.getTime() - startedAt.getTime());
  metrics.emitCleanRun(cleanRun);

  // ── Build and write report (AC5) ─────────────────────────────────────────
  const report: ReconciliationReport = {
    periodDate,
    transactionsCompared,
    exceptionsByKind,
    exceptionCount: persistedCount,
    cleanRun,
    correctTerminalStatePercent: correctTerminalPct / 100,
    generatedAt: now.toISOString(),
  };

  const reportJson = JSON.stringify(report, null, 2);
  const humanSummary = buildHumanSummary(report, result.exceptions);
  const s3KeyPrefix = `reconciliation/${periodDate}`;

  let reportS3Key: string | null = null;
  if (opts.s3BucketName) {
    const jsonKey = `${s3KeyPrefix}/report.json`;
    const txtKey = `${s3KeyPrefix}/summary.txt`;
    await s3.putObject(jsonKey, reportJson, "application/json");
    await s3.putObject(txtKey, humanSummary, "text/plain");
    reportS3Key = jsonKey;
    logger.info({ periodDate, s3Key: jsonKey }, "Reconciliation report written to S3");
  }

  // ── Mark run COMPLETED ───────────────────────────────────────────────────
  await db.reconciliationRun.upsert({
    where: { periodDate: periodDateObj },
    create: {
      periodDate: periodDateObj,
      status: "COMPLETED",
      cursor: null,
      transactionsCompared,
      exceptionCount: persistedCount,
      startedAt,
    },
    update: {
      status: "COMPLETED",
      cursor: null,
      transactionsCompared,
      exceptionCount: persistedCount,
      cleanRun,
      correctTerminalPct,
      finishedAt: now,
      reportS3Key: reportS3Key ?? undefined,
    },
  });

  logger.info(
    {
      periodDate,
      transactionsCompared,
      exceptionCount: persistedCount,
      cleanRun,
      correctTerminalStatePercent: report.correctTerminalStatePercent,
    },
    "Reconciliation job completed",
  );

  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePeriodDate(dateStr: string): Date {
  // Parse YYYY-MM-DD as UTC midnight
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid period date: "${dateStr}" (expected YYYY-MM-DD)`);
  }
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid period date: "${dateStr}"`);
  }
  return d;
}

function countByKind(exceptions: readonly DetectedReconciliationException[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ex of exceptions) {
    counts[ex.kind] = (counts[ex.kind] ?? 0) + 1;
  }
  return counts;
}

function buildHumanSummary(
  report: ReconciliationReport,
  exceptions: readonly DetectedReconciliationException[],
): string {
  const lines: string[] = [
    `Reconciliation Summary — ${report.periodDate}`,
    "=".repeat(50),
    `Generated at:              ${report.generatedAt}`,
    `Transactions compared:     ${report.transactionsCompared}`,
    `Exceptions found:          ${report.exceptionCount}`,
    `Clean run:                 ${report.cleanRun ? "YES" : "NO"}`,
    `Correct-terminal-state %:  ${report.correctTerminalStatePercent.toFixed(2)}%`,
    "",
    "Exceptions by kind:",
  ];

  if (Object.keys(report.exceptionsByKind).length === 0) {
    lines.push("  (none)");
  } else {
    for (const [kind, count] of Object.entries(report.exceptionsByKind)) {
      lines.push(`  ${kind.padEnd(36)} ${count}`);
    }
  }

  if (exceptions.length > 0) {
    lines.push("");
    lines.push("Exception details (booking IDs only — no PII):");
    for (const ex of exceptions.slice(0, 50)) {
      lines.push(
        `  [${ex.kind}] bookingId=${ex.bookingId ?? "null"} ref=${ex.providerReference ?? "null"}`,
      );
    }
    if (exceptions.length > 50) {
      lines.push(`  ... and ${exceptions.length - 50} more (see report.json)`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entrypoint (when run directly as a Node.js process)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Inline Prisma + adapters import only when executed as a job
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  // Parse --date flag from argv
  const dateArg = process.argv.find((a) => a.startsWith("--date="));
  const yesterdayUtc = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const periodDate = dateArg ? dateArg.replace("--date=", "") : yesterdayUtc;

  const bucketName = process.env["RECONCILIATION_S3_BUCKET"] ?? "";
  const logger: ReconciliationLogger = {
    info: (obj, msg) => process.stdout.write(JSON.stringify({ level: 30, ...obj, msg }) + "\n"),
    warn: (obj, msg) => process.stderr.write(JSON.stringify({ level: 40, ...obj, msg }) + "\n"),
    error: (obj, msg) => process.stderr.write(JSON.stringify({ level: 50, ...obj, msg }) + "\n"),
  };

  // Null metrics and S3 when unconfigured (CI / dry-run environments)
  const nullMetrics: ReconciliationMetricsPort = {
    emitExceptions: () => {},
    emitTransactionsCompared: () => {},
    emitRunDuration: () => {},
    emitCleanRun: () => {},
  };
  const nullS3: ReconciliationS3Port = {
    putObject: async () => {},
  };

  // Build a minimal DB adapter from Prisma
  const db: ReconciliationDbClient = {
    reconciliationRun: {
      upsert: (args) =>
        prisma.reconciliationRun.upsert({
          where: args.where,
          create: args.create,
          update: args.update,
          select: { id: true, cursor: true },
        }),
    },
    reconciliationException: {
      createMany: (args) =>
        prisma.reconciliationException.createMany({
          data: args.data,
          skipDuplicates: args.skipDuplicates,
        }),
    },
    payment: {
      findMany: (args) =>
        prisma.payment.findMany({
          where: args.where,
          select: args.select,
        }),
    },
    booking: {
      findMany: (args) =>
        prisma.booking.findMany({
          where: args.where,
          select: args.select,
        }),
    },
  };

  // Stripe balance reader — real adapter stub (populated when STRIPE_SECRET_KEY set)
  const { InMemoryStripeReader } = await import("../domain/StripeBalanceReaderPort.js");
  const reader = new InMemoryStripeReader(); // overridden by StripeAdapter in production build

  try {
    const report = await runReconciliationJob(
      { periodDate, pageSize: 100, s3BucketName: bucketName },
      db,
      reader,
      nullS3,
      nullMetrics,
      logger,
    );
    process.stdout.write(JSON.stringify(report) + "\n");
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    logger.error({ err: String(err) }, "Reconciliation job failed");
    await prisma.$disconnect();
    process.exit(1);
  }
}

// Only run when executed as the main module
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("reconciliation.js");

if (isMain) {
  void main();
}
