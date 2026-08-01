/**
 * Verifies that the funnel_event table is registered for physical deletion
 * and that the PurgeOrchestrator dispatches physical_delete for it (WO-106 AC10).
 *
 * This test uses the real CLASSIFICATION_REGISTER (not a stub) so any removal
 * of the funnel_event entry from the register will fail the test.
 */

import { describe, it, expect, vi } from "vitest";
import {
  PurgeOrchestrator,
  SpyPurgeMetrics,
  SystemPurgeClock,
  type PurgeRepositoryPort,
  type PurgeLogger,
  type CategoryPurgeStrategy,
} from "../src/index.js";
import { CLASSIFICATION_REGISTER } from "@travel/contracts/retention";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeStubbedRepo(): PurgeRepositoryPort {
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
  };
}

function makeLogger(): PurgeLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makePhysicalDeleteStrategy(): CategoryPurgeStrategy & { executeCallArgs: unknown[][] } {
  const executeCallArgs: unknown[][] = [];
  return {
    name: "physical_delete",
    executeCallArgs,
    execute: vi.fn().mockImplementation(async (entry: unknown, opts: unknown) => {
      executeCallArgs.push([entry, opts]);
      return { examined: 5, purged: 5, keysDestroyed: 0, skippedLegalHold: 0, status: "success" };
    }),
  };
}

const NOW = new Date("2026-01-01T00:00:00Z");
const clock = { now: () => NOW } as unknown as SystemPurgeClock;

// ---------------------------------------------------------------------------
// Tests: funnel_event register entry
// ---------------------------------------------------------------------------

describe("CLASSIFICATION_REGISTER — funnel_event entry", () => {
  it("contains a funnel_event.telemetry entry", () => {
    const entry = CLASSIFICATION_REGISTER.entries.find((e) => e.id === "funnel_event.telemetry");
    expect(entry).toBeDefined();
    expect(entry?.table).toBe("funnel_event");
  });

  it("funnel_event entry uses physical_delete erasure method", () => {
    const entry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    expect(entry?.erasureMethod).toBe("physical_delete");
  });

  it("funnel_event entry is NOT erasureExcluded", () => {
    const entry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    expect(entry?.erasureExcluded).toBe(false);
  });

  it("funnel_event entry is NOT included in DSR export (pseudonymous data)", () => {
    const entry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    expect(entry?.includedInDsrExport).toBe(false);
  });

  it("funnel_event entry covers pseudonymous_actor_id column", () => {
    const entry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    expect(entry?.columns).toContain("pseudonymous_actor_id");
  });

  it("funnel_event entry has INTERNAL data classification", () => {
    const entry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    expect(entry?.classification).toBe("INTERNAL");
  });

  it("retentionPeriodKey is null (purge_after computed at row insert time)", () => {
    const entry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    expect(entry?.retentionPeriodKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: PurgeOrchestrator dispatches physical_delete for funnel_event
// ---------------------------------------------------------------------------

describe("PurgeOrchestrator — funnel_event physical deletion", () => {
  it("dispatches physical_delete strategy for the funnel_event entry", async () => {
    // Use only the funnel_event entry from the real register to keep this test focused
    const funnelEntry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    expect(funnelEntry).toBeDefined(); // guard

    const funnelOnlyRegister = { ...CLASSIFICATION_REGISTER, entries: [funnelEntry!] };
    const strategy = makePhysicalDeleteStrategy();
    const metrics = new SpyPurgeMetrics();
    const repo = makeStubbedRepo();

    const orchestrator = new PurgeOrchestrator(
      funnelOnlyRegister,
      new Map([["physical_delete", strategy]]),
      repo,
      clock,
      metrics,
      makeLogger(),
    );

    const result = await orchestrator.run({ dryRun: false, correlationId: "funnel-purge-test" });

    expect(result.hasFailures).toBe(false);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]?.table).toBe("funnel_event");
    expect(result.categories[0]?.status).toBe("success");
    expect(result.categories[0]?.purged).toBe(5);
    expect(strategy.execute).toHaveBeenCalledOnce();
  });

  it("records purge audit record for funnel_event physical deletion", async () => {
    const funnelEntry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    const funnelOnlyRegister = { ...CLASSIFICATION_REGISTER, entries: [funnelEntry!] };
    const strategy = makePhysicalDeleteStrategy();
    const repo = makeStubbedRepo();

    const orchestrator = new PurgeOrchestrator(
      funnelOnlyRegister,
      new Map([["physical_delete", strategy]]),
      repo,
      clock,
      new SpyPurgeMetrics(),
      makeLogger(),
    );

    await orchestrator.run({ dryRun: false, correlationId: "funnel-audit-test" });

    expect(repo.recordPurgeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "Funnel telemetry event",
        purged: 5,
        dryRun: false,
        status: "success",
      }),
    );
  });

  it("does NOT purge in dry-run mode (no deleteBatch call)", async () => {
    const funnelEntry = CLASSIFICATION_REGISTER.entries.find((e) => e.table === "funnel_event");
    const funnelOnlyRegister = { ...CLASSIFICATION_REGISTER, entries: [funnelEntry!] };

    // Dry-run strategy that returns 0 purged (matches real PhysicalDeleteStrategy dry-run behaviour)
    const dryRunStrategy: CategoryPurgeStrategy = {
      name: "physical_delete",
      execute: vi.fn().mockResolvedValue({
        examined: 5, purged: 0, keysDestroyed: 0, skippedLegalHold: 0, status: "skipped",
      }),
    };
    const repo = makeStubbedRepo();

    const orchestrator = new PurgeOrchestrator(
      funnelOnlyRegister,
      new Map([["physical_delete", dryRunStrategy]]),
      repo,
      clock,
      new SpyPurgeMetrics(),
      makeLogger(),
    );

    const result = await orchestrator.run({ dryRun: true, correlationId: "funnel-dryrun-test" });

    expect(result.categories[0]?.status).toBe("skipped");
    expect(repo.deleteBatch).not.toHaveBeenCalled();
    expect(repo.recordPurgeRun).not.toHaveBeenCalled();
  });
});
