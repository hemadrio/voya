/**
 * Unit tests for the reconciliation job runner (WO-050 AC6, AC9).
 *
 * Uses in-memory fakes for all infrastructure (no Prisma, no S3, no Stripe SDK).
 * Tests:
 *   - Clean run produces a report with cleanRun=true
 *   - Idempotency: second run for same date skips duplicate exceptions
 *   - Cursor persistence: cursor saved after each page
 *   - Correct-terminal-state percentage computation
 *   - Exception count metric emitted
 */

import { describe, it, expect, vi } from "vitest";
import { runReconciliationJob } from "../../src/jobs/reconciliation.js";
import type {
  ReconciliationDbClient,
  ReconciliationLogger,
  ReconciliationS3Port,
  ReconciliationMetricsPort,
} from "../../src/jobs/reconciliation.js";
import { InMemoryStripeReader } from "../../src/domain/StripeBalanceReaderPort.js";
import {
  CLEAN_PROVIDER_TRANSACTIONS,
  PERIOD_DATE,
  SYNTH_BOOKING_CONFIRMED,
} from "../fixtures/reconciliation-fixtures.js";
import type { LedgerRow, BookingState } from "../../src/domain/ReconciliationEngine.js";

// ---------------------------------------------------------------------------
// In-memory DB fake
// ---------------------------------------------------------------------------

function makeDb(
  ledgerRows: LedgerRow[] = [],
  bookingStates: BookingState[] = [],
): ReconciliationDbClient & {
  runs: Array<Record<string, unknown>>;
  exceptions: Array<Record<string, unknown>>;
} {
  const runs: Array<Record<string, unknown>> = [];
  const exceptions: Array<Record<string, unknown>> = [];

  const runStore = new Map<string, Record<string, unknown>>();

  const db: ReconciliationDbClient & {
    runs: typeof runs;
    exceptions: typeof exceptions;
  } = {
    runs,
    exceptions,
    reconciliationRun: {
      async upsert(args) {
        const key = args.where.periodDate.toISOString();
        const existing = runStore.get(key);
        if (existing) {
          Object.assign(existing, args.update);
        } else {
          const created = { id: "run-001", ...args.create } as Record<string, unknown>;
          runStore.set(key, created);
          runs.push(created);
        }
        const row = runStore.get(key)!;
        return { id: row.id as string, cursor: (row.cursor as string | null) ?? null };
      },
    },
    reconciliationException: {
      async createMany(args) {
        let inserted = 0;
        for (const ex of args.data) {
          const key = `${ex.kind}|${ex.providerReference ?? "null"}|${ex.periodDate.toISOString()}`;
          const isDuplicate = exceptions.some(
            (e) => `${e.kind}|${e.providerReference ?? "null"}|${(e.periodDate as Date).toISOString()}` === key,
          );
          if (!isDuplicate || !args.skipDuplicates) {
            exceptions.push({ ...ex });
            inserted++;
          }
        }
        return { count: inserted };
      },
    },
    payment: {
      async findMany() {
        return ledgerRows as LedgerRow[];
      },
    },
    booking: {
      async findMany() {
        return bookingStates;
      },
    },
  };
  return db;
}

const nullLogger: ReconciliationLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const nullS3: ReconciliationS3Port = {
  putObject: async () => {},
};

const nullMetrics: ReconciliationMetricsPort = {
  emitExceptions: vi.fn(),
  emitTransactionsCompared: vi.fn(),
  emitRunDuration: vi.fn(),
  emitCleanRun: vi.fn(),
};

// ---------------------------------------------------------------------------
// Clean run
// ---------------------------------------------------------------------------

describe("ReconciliationJob: clean run (AC9)", () => {
  it("produces cleanRun=true and zero exceptions when all transactions match", async () => {
    const db = makeDb(
      [
        {
          id: "led-001",
          bookingId: SYNTH_BOOKING_CONFIRMED,
          type: "CHARGE",
          providerReference: CLEAN_PROVIDER_TRANSACTIONS[0]!.paymentIntentId!,
          amountMinor: CLEAN_PROVIDER_TRANSACTIONS[0]!.amountMinor,
          currency: "usd",
          status: "SUCCEEDED",
        },
      ],
      [{ id: SYNTH_BOOKING_CONFIRMED, status: "CONFIRMED" }],
    );
    const reader = new InMemoryStripeReader(CLEAN_PROVIDER_TRANSACTIONS);

    const report = await runReconciliationJob(
      { periodDate: PERIOD_DATE, pageSize: 100 },
      db,
      reader,
      nullS3,
      nullMetrics,
      nullLogger,
    );

    expect(report.cleanRun).toBe(true);
    expect(report.exceptionCount).toBe(0);
    expect(report.transactionsCompared).toBe(1);
    expect(report.correctTerminalStatePercent).toBeCloseTo(100, 1);
  });

  it("emits correct periodDate in report", async () => {
    const db = makeDb([], []);
    const reader = new InMemoryStripeReader([]);

    const report = await runReconciliationJob(
      { periodDate: "2026-08-01", pageSize: 100 },
      db,
      reader,
      nullS3,
      nullMetrics,
      nullLogger,
    );

    expect(report.periodDate).toBe("2026-08-01");
    expect(report.generatedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency (AC6)
// ---------------------------------------------------------------------------

describe("ReconciliationJob: idempotency (AC6)", () => {
  it("second run for same date does not insert duplicate exceptions (skipDuplicates)", async () => {
    const ledger = [
      {
        id: "led-002",
        bookingId: "f0000010-0000-4000-8000-000000000099",
        type: "CHARGE" as const,
        providerReference: "pi_test_idem",
        amountMinor: 19999n,
        currency: "usd",
        status: "SUCCEEDED",
      },
    ];
    const transactions = [
      {
        id: "bt_test_idem",
        sourceId: "ch_test_idem",
        type: "charge" as const,
        amountMinor: 19999n,
        currency: "usd",
        bookingId: "f0000010-0000-4000-8000-000000000099",
        paymentIntentId: "pi_test_idem",
        settledAt: 1754006400,
      },
    ];

    const db = makeDb(ledger, [
      { id: "f0000010-0000-4000-8000-000000000099", status: "PENDING" }, // causes SETTLED_WITHOUT_CONFIRMATION
    ]);

    const reader = new InMemoryStripeReader(transactions);

    // First run
    const r1 = await runReconciliationJob(
      { periodDate: PERIOD_DATE },
      db,
      reader,
      nullS3,
      nullMetrics,
      nullLogger,
    );
    expect(r1.exceptionCount).toBe(1);
    expect(db.exceptions).toHaveLength(1);

    // Second run — same period, reader re-seeded (simulates re-run after cursor cleared)
    const reader2 = new InMemoryStripeReader(transactions);
    const r2 = await runReconciliationJob(
      { periodDate: PERIOD_DATE },
      db,
      reader2,
      nullS3,
      nullMetrics,
      nullLogger,
    );
    // skipDuplicates=true means no new rows inserted
    expect(r2.exceptionCount).toBe(0); // second run found 0 NEW rows (duplicate skipped)
    expect(db.exceptions).toHaveLength(1); // still only one row total
  });
});

// ---------------------------------------------------------------------------
// Cursor persistence (resumability — AC1)
// ---------------------------------------------------------------------------

describe("ReconciliationJob: cursor pagination (AC1)", () => {
  it("persists cursor after each page and completes when nextCursor is null", async () => {
    // Build 3 pages of 2 transactions each
    const txns = Array.from({ length: 6 }, (_, i) => ({
      id: `bt_page_${i}`,
      sourceId: `ch_page_${i}`,
      type: "charge" as const,
      amountMinor: 9999n,
      currency: "usd",
      bookingId: `f0000010-0000-4000-8000-00000000000${i}`,
      paymentIntentId: `pi_page_${i}`,
      settledAt: 1754006400,
    }));

    const db = makeDb([], []);
    const reader = new InMemoryStripeReader(txns);

    const report = await runReconciliationJob(
      { periodDate: PERIOD_DATE, pageSize: 2 },
      db,
      reader,
      nullS3,
      nullMetrics,
      nullLogger,
    );

    // 3 pages of 2 items = 3 listPage calls (pages 1, 2, 3)
    expect(reader.pageCalls).toHaveLength(3);
    // First page has null startingAfter
    expect(reader.pageCalls[0]!.startingAfter).toBeNull();
    // Subsequent pages have a cursor
    expect(reader.pageCalls[1]!.startingAfter).toBeDefined();
    expect(report.transactionsCompared).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// S3 report write (AC5)
// ---------------------------------------------------------------------------

describe("ReconciliationJob: S3 report (AC5)", () => {
  it("writes report.json and summary.txt to S3 when bucket configured", async () => {
    const written: Array<{ key: string; body: string; contentType: string }> = [];
    const s3: ReconciliationS3Port = {
      async putObject(key, body, contentType) {
        written.push({ key, body, contentType });
      },
    };

    const db = makeDb([], []);
    const reader = new InMemoryStripeReader([]);

    await runReconciliationJob(
      { periodDate: PERIOD_DATE, s3BucketName: "test-bucket" },
      db,
      reader,
      s3,
      nullMetrics,
      nullLogger,
    );

    expect(written.find((w) => w.key.endsWith("report.json"))).toBeDefined();
    expect(written.find((w) => w.key.endsWith("summary.txt"))).toBeDefined();

    const jsonReport = JSON.parse(written.find((w) => w.key.endsWith("report.json"))!.body);
    expect(jsonReport.periodDate).toBe(PERIOD_DATE);
    expect(typeof jsonReport.correctTerminalStatePercent).toBe("number");
    expect(typeof jsonReport.cleanRun).toBe("boolean");
  });

  it("report JSON contains no '@' characters (no email/PII)", async () => {
    const written: Array<{ key: string; body: string }> = [];
    const s3: ReconciliationS3Port = {
      async putObject(key, body) { written.push({ key, body }); },
    };
    const db = makeDb([], []);
    const reader = new InMemoryStripeReader([]);

    await runReconciliationJob(
      { periodDate: PERIOD_DATE, s3BucketName: "test-bucket" },
      db,
      reader,
      s3,
      nullMetrics,
      nullLogger,
    );

    for (const { body } of written) {
      expect(body).not.toMatch(/@/);
    }
  });
});

// ---------------------------------------------------------------------------
// Metrics emission (AC4)
// ---------------------------------------------------------------------------

describe("ReconciliationJob: metrics emission (AC4)", () => {
  it("calls emitTransactionsCompared and emitCleanRun", async () => {
    const emitCalls: Record<string, unknown[]> = {
      transactionsCompared: [],
      cleanRun: [],
      exceptions: [],
      runDuration: [],
    };
    const metrics: ReconciliationMetricsPort = {
      emitExceptions: (v) => emitCalls.exceptions.push(v),
      emitTransactionsCompared: (v) => emitCalls.transactionsCompared.push(v),
      emitRunDuration: (v) => emitCalls.runDuration.push(v),
      emitCleanRun: (v) => emitCalls.cleanRun.push(v),
    };

    const db = makeDb([], []);
    const reader = new InMemoryStripeReader([]);

    await runReconciliationJob(
      { periodDate: PERIOD_DATE },
      db,
      reader,
      nullS3,
      metrics,
      nullLogger,
    );

    expect(emitCalls.transactionsCompared).toHaveLength(1);
    expect(emitCalls.cleanRun).toHaveLength(1);
    expect(emitCalls.runDuration).toHaveLength(1);
    expect(emitCalls.exceptions).toHaveLength(1);
  });
});
