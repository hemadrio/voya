/**
 * PurgeOrchestrator unit tests.
 *
 * All dependencies are test doubles — no DB or AWS access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PurgeOrchestrator,
  SpyPurgeMetrics,
  SystemPurgeClock,
  type PurgeRepositoryPort,
  type PurgeLogger,
  type CategoryPurgeStrategy,
  type StrategyResult,
} from "../src/index.js";
import type { ClassificationRegister } from "@travel/contracts/retention";

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

function makeStubbedRepo(overrides: Partial<PurgeRepositoryPort> = {}): PurgeRepositoryPort {
  return {
    countExpired: vi.fn().mockResolvedValue(0),
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

function makeLogger(): PurgeLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeStrategy(name: string, result: Partial<StrategyResult> = {}): CategoryPurgeStrategy {
  return {
    name,
    execute: vi.fn().mockResolvedValue({
      examined: 0,
      purged: 0,
      keysDestroyed: 0,
      skippedLegalHold: 0,
      status: "success",
      ...result,
    }),
  };
}

// Minimal register with one physical_delete entry
function makeRegister(entries: ClassificationRegister["entries"]): ClassificationRegister {
  return { entries };
}

const NOW = new Date("2026-01-01T00:00:00Z");
const clock: SystemPurgeClock = { now: () => NOW } as unknown as SystemPurgeClock;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PurgeOrchestrator", () => {
  let metrics: SpyPurgeMetrics;

  beforeEach(() => {
    metrics = new SpyPurgeMetrics();
  });

  it("returns success with no failures when all categories succeed", async () => {
    const strategy = makeStrategy("physical_delete", { examined: 10, purged: 5 });
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), makeStubbedRepo(), clock, metrics, makeLogger());

    const result = await orchestrator.run({ dryRun: true, correlationId: "test-1" });

    expect(result.hasFailures).toBe(false);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]?.status).toBe("skipped"); // dry-run strategy returns skipped
  });

  it("skips entry when lease cannot be acquired", async () => {
    const repo = makeStubbedRepo({ acquireLease: vi.fn().mockResolvedValue(false) });
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map(), repo, clock, metrics, makeLogger());

    const result = await orchestrator.run({ dryRun: false, correlationId: "test-lease" });

    expect(result.categories).toHaveLength(0);
    expect(result.hasFailures).toBe(false);
  });

  it("records failure and sets hasFailures when strategy throws", async () => {
    const throwingStrategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockRejectedValue(new Error("DB error")),
    };
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", throwingStrategy]]), makeStubbedRepo(), clock, metrics, makeLogger());

    const result = await orchestrator.run({ dryRun: false, correlationId: "test-throw" });

    expect(result.hasFailures).toBe(true);
    expect(result.categories[0]?.status).toBe("failure");
    expect(metrics.failures).toContain("account_identity");
  });

  it("always releases lease even when strategy throws", async () => {
    const repo = makeStubbedRepo();
    const throwingStrategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockRejectedValue(new Error("DB error")),
    };
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", throwingStrategy]]), repo, clock, metrics, makeLogger());

    await orchestrator.run({ dryRun: false, correlationId: "test-lease-release" });

    expect(repo.releaseLease).toHaveBeenCalledWith("purge:global");
  });

  it("marks entry as excluded when erasureExcluded=true and erasureMethod=none", async () => {
    const register = makeRegister([
      { id: "B", category: "booking_audit", table: "booking_audit_log", erasureMethod: "none", erasureExcluded: true } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map(), makeStubbedRepo(), clock, metrics, makeLogger());

    const result = await orchestrator.run({ dryRun: false, correlationId: "test-excluded" });

    expect(result.categories[0]?.status).toBe("excluded");
    expect(result.hasFailures).toBe(false);
  });

  it("records failure for guard violation: erasureExcluded=true with physical_delete", async () => {
    const register = makeRegister([
      { id: "C", category: "bad_entry", table: "users", erasureMethod: "physical_delete", erasureExcluded: true } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", makeStrategy("physical_delete")]]), makeStubbedRepo(), clock, metrics, makeLogger());

    const result = await orchestrator.run({ dryRun: false, correlationId: "test-guard" });

    expect(result.hasFailures).toBe(true);
    expect(result.categories[0]?.status).toBe("failure");
    expect(result.categories[0]?.errorMessage).toMatch(/erasure_excluded/);
  });

  it("defers category when DB load exceeds threshold", async () => {
    const repo = makeStubbedRepo({ getDbLoadFactor: vi.fn().mockResolvedValue(0.9) });
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", makeStrategy("physical_delete")]]), repo, clock, metrics, makeLogger(), { loadThreshold: 0.7 });

    const result = await orchestrator.run({ dryRun: false, correlationId: "test-load" });

    expect(result.categories[0]?.status).toBe("skipped");
    expect(result.hasFailures).toBe(false);
  });

  it("records audit run for non-dry-run purges with purged > 0", async () => {
    const repo = makeStubbedRepo();
    const strategy = makeStrategy("physical_delete", { examined: 10, purged: 5, status: "success" });
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), repo, clock, metrics, makeLogger());

    await orchestrator.run({ dryRun: false, correlationId: "test-audit" });

    expect(repo.recordPurgeRun).toHaveBeenCalledWith(
      expect.objectContaining({ category: "account_identity", purged: 5, dryRun: false }),
    );
  });

  it("records no audit run in dry-run mode", async () => {
    const repo = makeStubbedRepo();
    const strategy = makeStrategy("physical_delete", { examined: 10, purged: 0, status: "skipped" });
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    const orchestrator = new PurgeOrchestrator(register, new Map([["physical_delete", strategy]]), repo, clock, metrics, makeLogger());

    await orchestrator.run({ dryRun: true, correlationId: "test-dry-audit" });

    expect(repo.recordPurgeRun).not.toHaveBeenCalled();
  });

  it("records failure when no strategy exists for erasureMethod", async () => {
    const register = makeRegister([
      { id: "A", category: "account_identity", table: "users", erasureMethod: "physical_delete", erasureExcluded: false } as any,
    ]);
    // no strategies registered
    const orchestrator = new PurgeOrchestrator(register, new Map(), makeStubbedRepo(), clock, metrics, makeLogger());

    const result = await orchestrator.run({ dryRun: false, correlationId: "test-no-strategy" });

    expect(result.hasFailures).toBe(true);
    expect(result.categories[0]?.status).toBe("failure");
  });
});
