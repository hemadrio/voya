/**
 * PhysicalDeleteStrategy unit tests.
 */

import { describe, it, expect, vi } from "vitest";
import { PhysicalDeleteStrategy } from "../../src/strategies/PhysicalDeleteStrategy.js";
import type { PurgeRepositoryPort, PurgeLogger } from "../../src/types.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function makeRepo(overrides: Partial<PurgeRepositoryPort> = {}): PurgeRepositoryPort {
  return {
    countExpired: vi.fn().mockResolvedValue(3),
    deleteBatch: vi.fn().mockResolvedValue(0),
    fetchErasureCandidates: vi.fn(),
    nullifyWrappedDek: vi.fn(),
    pseudonymiseActor: vi.fn(),
    deleteConversationKeys: vi.fn(),
    recordPurgeRun: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    getDbLoadFactor: vi.fn(),
    quarantine: vi.fn(),
    ...overrides,
  } as PurgeRepositoryPort;
}

function makeLogger(): PurgeLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const entry: any = { id: "E1", category: "account_identity", table: "users" };

describe("PhysicalDeleteStrategy", () => {
  it("returns examined count and purged=0 in dry-run mode", async () => {
    const repo = makeRepo();
    const strategy = new PhysicalDeleteStrategy(repo, makeLogger());

    const result = await strategy.execute(entry, {
      now: NOW, batchSize: 100, interBatchPauseMs: 0, dryRun: true, correlationId: "c1", maxBatches: 10,
    });

    expect(result.status).toBe("skipped");
    expect(result.examined).toBe(3);
    expect(result.purged).toBe(0);
    expect(repo.deleteBatch).not.toHaveBeenCalled();
  });

  it("calls deleteBatch and accumulates purged rows", async () => {
    const repo = makeRepo({
      // First batch returns 100 (full batch), second returns 50 (last)
      deleteBatch: vi.fn()
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(50),
    });
    const strategy = new PhysicalDeleteStrategy(repo, makeLogger());

    const result = await strategy.execute(entry, {
      now: NOW, batchSize: 100, interBatchPauseMs: 0, dryRun: false, correlationId: "c2", maxBatches: 10,
    });

    expect(result.status).toBe("success");
    expect(result.purged).toBe(150);
    expect(repo.deleteBatch).toHaveBeenCalledTimes(2);
  });

  it("stops after maxBatches even if more rows remain", async () => {
    const repo = makeRepo({ deleteBatch: vi.fn().mockResolvedValue(100) });
    const strategy = new PhysicalDeleteStrategy(repo, makeLogger());

    const result = await strategy.execute(entry, {
      now: NOW, batchSize: 100, interBatchPauseMs: 0, dryRun: false, correlationId: "c3", maxBatches: 3,
    });

    expect(repo.deleteBatch).toHaveBeenCalledTimes(3);
    expect(result.purged).toBe(300);
  });
});
