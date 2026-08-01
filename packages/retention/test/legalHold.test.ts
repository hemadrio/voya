/**
 * Legal hold unit tests — WO-102.
 *
 * Verifies that rows with legal_hold=true are:
 *   - Counted and reported via skippedLegalHold (not silently dropped)
 *   - Never deleted or crypto-erased by any strategy
 *   - Surfaced in PurgeOrchestrator metrics and audit records
 *
 * All dependencies are test doubles — no DB or AWS access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PhysicalDeleteStrategy } from "../src/strategies/PhysicalDeleteStrategy.js";
import { CryptoEraseStrategy } from "../src/strategies/CryptoEraseStrategy.js";
import { PurgeOrchestrator, SpyPurgeMetrics } from "../src/index.js";
import { InMemoryEnvelopeCipher } from "@travel/crypto";
import type { PurgeRepositoryPort, PurgeLogger, StrategyResult } from "../src/types.js";
import type { CategoryPurgeStrategy } from "../src/types.js";
import type { ClassificationRegister } from "@travel/contracts/retention";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00Z");

function makeLogger(): PurgeLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRepo(overrides: Partial<PurgeRepositoryPort> = {}): PurgeRepositoryPort {
  return {
    countExpired: vi.fn().mockResolvedValue(5),
    countLegalHold: vi.fn().mockResolvedValue(0),
    deleteBatch: vi.fn().mockResolvedValue(0),
    fetchErasureCandidates: vi.fn().mockResolvedValue([]),
    nullifyWrappedDek: vi.fn().mockResolvedValue(0),
    pseudonymiseActor: vi.fn().mockResolvedValue(0),
    deleteConversationKeys: vi.fn().mockResolvedValue(0),
    recordPurgeRun: vi.fn().mockResolvedValue(undefined),
    acquireLease: vi.fn().mockResolvedValue(true),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    getDbLoadFactor: vi.fn().mockResolvedValue(0),
    quarantine: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const entry: any = { id: "E1", category: "booking_travelers", table: "booking_travelers" };

const baseOptions = {
  now: NOW,
  batchSize: 100,
  interBatchPauseMs: 0,
  correlationId: "legal-hold-test",
  maxBatches: 10,
};

// ---------------------------------------------------------------------------
// PhysicalDeleteStrategy — legal hold
// ---------------------------------------------------------------------------

describe("PhysicalDeleteStrategy — legal hold", () => {
  it("dry-run: reports skippedLegalHold from countLegalHold, does not call deleteBatch", async () => {
    const repo = makeRepo({
      countExpired: vi.fn().mockResolvedValue(10),
      countLegalHold: vi.fn().mockResolvedValue(3),
    });
    const strategy = new PhysicalDeleteStrategy(repo, makeLogger());

    const result = await strategy.execute(entry, { ...baseOptions, dryRun: true });

    expect(result.status).toBe("skipped");
    expect(result.examined).toBe(10);
    expect(result.purged).toBe(0);
    expect(result.skippedLegalHold).toBe(3);
    expect(repo.deleteBatch).not.toHaveBeenCalled();
    expect(repo.countLegalHold).toHaveBeenCalledWith(entry.table, NOW);
  });

  it("live run: skippedLegalHold is populated even though deleteBatch excludes those rows", async () => {
    const repo = makeRepo({
      countExpired: vi.fn().mockResolvedValue(7),
      countLegalHold: vi.fn().mockResolvedValue(2),
      // Only 5 non-legal-hold rows deleted (enforced in repository layer)
      deleteBatch: vi.fn().mockResolvedValueOnce(5).mockResolvedValue(0),
    });
    const strategy = new PhysicalDeleteStrategy(repo, makeLogger());

    const result = await strategy.execute(entry, { ...baseOptions, dryRun: false });

    expect(result.status).toBe("success");
    expect(result.purged).toBe(5);
    expect(result.skippedLegalHold).toBe(2);
    expect(repo.deleteBatch).toHaveBeenCalled();
  });

  it("returns skippedLegalHold=0 when no rows are under legal hold", async () => {
    const repo = makeRepo({
      countLegalHold: vi.fn().mockResolvedValue(0),
      deleteBatch: vi.fn().mockResolvedValueOnce(3).mockResolvedValue(0),
    });
    const strategy = new PhysicalDeleteStrategy(repo, makeLogger());

    const result = await strategy.execute(entry, { ...baseOptions, dryRun: false });

    expect(result.skippedLegalHold).toBe(0);
  });

  it("emits a warn log when legal_hold rows are present in a live run", async () => {
    const logger = makeLogger();
    const repo = makeRepo({
      countLegalHold: vi.fn().mockResolvedValue(4),
      deleteBatch: vi.fn().mockResolvedValue(0),
    });
    const strategy = new PhysicalDeleteStrategy(repo, logger);

    await strategy.execute(entry, { ...baseOptions, dryRun: false });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skippedLegalHold: 4, category: entry.category }),
      expect.stringContaining("legal_hold"),
    );
  });
});

// ---------------------------------------------------------------------------
// CryptoEraseStrategy — legal hold
// ---------------------------------------------------------------------------

describe("CryptoEraseStrategy — legal hold", () => {
  it("dry-run: reports skippedLegalHold, does not call nullifyWrappedDek", async () => {
    const repo = makeRepo({
      countExpired: vi.fn().mockResolvedValue(8),
      countLegalHold: vi.fn().mockResolvedValue(2),
    });
    const cipher = new InMemoryEnvelopeCipher();
    const strategy = new CryptoEraseStrategy(repo, cipher, makeLogger());

    const result = await strategy.execute(entry, { ...baseOptions, dryRun: true });

    expect(result.status).toBe("skipped");
    expect(result.skippedLegalHold).toBe(2);
    expect(repo.nullifyWrappedDek).not.toHaveBeenCalled();
  });

  it("live run: countLegalHold is called and result is in skippedLegalHold", async () => {
    const repo = makeRepo({
      countExpired: vi.fn().mockResolvedValue(3),
      countLegalHold: vi.fn().mockResolvedValue(1),
      fetchErasureCandidates: vi.fn()
        .mockResolvedValueOnce([
          {
            id: "row-1",
            subjectId: "subj-1",
            wrappedDek: Buffer.from("fake-dek"),
            dekKeyId: "kms-key-1",
            bookingId: "booking-1",
          },
        ])
        .mockResolvedValue([]),
      nullifyWrappedDek: vi.fn().mockResolvedValue(1),
    });
    const cipher = new InMemoryEnvelopeCipher();
    const strategy = new CryptoEraseStrategy(repo, cipher, makeLogger());

    const result = await strategy.execute(entry, { ...baseOptions, dryRun: false });

    expect(result.skippedLegalHold).toBe(1);
    expect(result.keysDestroyed).toBe(1);
    expect(repo.countLegalHold).toHaveBeenCalledWith(entry.table, NOW);
  });
});

// ---------------------------------------------------------------------------
// PurgeOrchestrator — legal hold metrics and audit record
// ---------------------------------------------------------------------------

describe("PurgeOrchestrator — legal hold propagation", () => {
  let metrics: SpyPurgeMetrics;

  beforeEach(() => {
    metrics = new SpyPurgeMetrics();
  });

  function makeRegister(entries: ClassificationRegister["entries"]): ClassificationRegister {
    return { entries };
  }

  it("records skippedLegalHold metric when strategy returns skippedLegalHold > 0", async () => {
    const strategyResult: StrategyResult = {
      examined: 10,
      purged: 0,
      keysDestroyed: 0,
      skippedLegalHold: 3,
      status: "success",
    };
    const strategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockResolvedValue(strategyResult),
    };
    const register = makeRegister([
      { id: "A", category: "booking_travelers", table: "booking_travelers", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const repo = makeRepo();
    const clock = { now: () => NOW };
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), repo, clock, metrics, makeLogger());

    await orchestrator.run({ dryRun: false, correlationId: "orch-legal-1" });

    expect(metrics.skippedLegalHolds).toContainEqual({ category: "booking_travelers", count: 3 });
  });

  it("writes audit record when skippedLegalHold > 0 even with purged = 0", async () => {
    // This ensures legal_hold skips are visible in the audit trail (BR-13 counts-only).
    const strategyResult: StrategyResult = {
      examined: 5,
      purged: 0,
      keysDestroyed: 0,
      skippedLegalHold: 5,
      status: "success",
    };
    const strategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockResolvedValue(strategyResult),
    };
    const register = makeRegister([
      { id: "A", category: "booking_travelers", table: "booking_travelers", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const repo = makeRepo();
    const clock = { now: () => NOW };
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), repo, clock, metrics, makeLogger());

    await orchestrator.run({ dryRun: false, correlationId: "orch-legal-2" });

    // recordPurgeRun should be called even though purged=0, because skippedLegalHold > 0
    expect(repo.recordPurgeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "booking_travelers",
        purged: 0,
        skippedLegalHold: 5,
        dryRun: false,
      }),
    );
  });

  it("does NOT record skippedLegalHold metric when value is 0", async () => {
    const strategyResult: StrategyResult = {
      examined: 10,
      purged: 5,
      keysDestroyed: 0,
      skippedLegalHold: 0,
      status: "success",
    };
    const strategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockResolvedValue(strategyResult),
    };
    const register = makeRegister([
      { id: "A", category: "booking_travelers", table: "booking_travelers", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const repo = makeRepo();
    const clock = { now: () => NOW };
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), repo, clock, metrics, makeLogger());

    await orchestrator.run({ dryRun: false, correlationId: "orch-legal-3" });

    expect(metrics.skippedLegalHolds).toHaveLength(0);
  });

  it("does NOT write audit record for dry-run even with skippedLegalHold > 0", async () => {
    const strategyResult: StrategyResult = {
      examined: 5,
      purged: 0,
      keysDestroyed: 0,
      skippedLegalHold: 5,
      status: "skipped",
    };
    const strategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockResolvedValue(strategyResult),
    };
    const register = makeRegister([
      { id: "A", category: "booking_travelers", table: "booking_travelers", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const repo = makeRepo();
    const clock = { now: () => NOW };
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), repo, clock, metrics, makeLogger());

    await orchestrator.run({ dryRun: true, correlationId: "orch-legal-dryrun" });

    expect(repo.recordPurgeRun).not.toHaveBeenCalled();
  });

  it("propagates skippedLegalHold into the CategoryRunResult", async () => {
    const strategyResult: StrategyResult = {
      examined: 7,
      purged: 2,
      keysDestroyed: 0,
      skippedLegalHold: 3,
      status: "success",
    };
    const strategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockResolvedValue(strategyResult),
    };
    const register = makeRegister([
      { id: "A", category: "booking_travelers", table: "booking_travelers", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const clock = { now: () => NOW };
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), makeRepo(), clock, metrics, makeLogger());

    const result = await orchestrator.run({ dryRun: false, correlationId: "orch-legal-4" });

    expect(result.categories[0]?.skippedLegalHold).toBe(3);
    expect(result.categories[0]?.purged).toBe(2);
  });
});
