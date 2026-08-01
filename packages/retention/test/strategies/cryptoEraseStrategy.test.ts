/**
 * CryptoEraseStrategy unit tests.
 *
 * Uses InMemoryEnvelopeCipher to verify DEK destruction without KMS.
 */

import { describe, it, expect, vi } from "vitest";
import { CryptoEraseStrategy } from "../../src/strategies/CryptoEraseStrategy.js";
import { InMemoryEnvelopeCipher } from "@travel/crypto";
import type { PurgeRepositoryPort, PurgeLogger, ErasureCandidate } from "../../src/types.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function makeLogger(): PurgeLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const fakeCandidate: ErasureCandidate = {
  id: "row-1",
  subjectId: "subj-1",
  wrappedDek: Buffer.from("fake-dek"),
  dekKeyId: "kms-key-1",
  bookingId: "booking-1",
};

function makeRepo(candidates: ErasureCandidate[] = []): PurgeRepositoryPort {
  return {
    countExpired: vi.fn().mockResolvedValue(candidates.length),
    countLegalHold: vi.fn().mockResolvedValue(0),
    deleteBatch: vi.fn().mockResolvedValue(0),
    fetchErasureCandidates: vi.fn()
      .mockResolvedValueOnce(candidates)
      .mockResolvedValue([]), // second batch = empty = done
    nullifyWrappedDek: vi.fn().mockResolvedValue(candidates.length),
    pseudonymiseActor: vi.fn(),
    deleteConversationKeys: vi.fn(),
    recordPurgeRun: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    getDbLoadFactor: vi.fn(),
    quarantine: vi.fn(),
  } as PurgeRepositoryPort;
}

const entry: any = { id: "E2", category: "traveler_identity", table: "booking_travelers" };

describe("CryptoEraseStrategy", () => {
  it("returns skipped with examined count in dry-run mode", async () => {
    const repo = makeRepo([fakeCandidate]);
    const cipher = new InMemoryEnvelopeCipher();
    const strategy = new CryptoEraseStrategy(repo, cipher, makeLogger());

    const result = await strategy.execute(entry, {
      now: NOW, batchSize: 10, interBatchPauseMs: 0, dryRun: true, correlationId: "c1", maxBatches: 10,
    });

    expect(result.status).toBe("skipped");
    expect(result.purged).toBe(0);
    expect(repo.nullifyWrappedDek).not.toHaveBeenCalled();
  });

  it("nullifies wrapped_dek for each erasure candidate", async () => {
    const repo = makeRepo([fakeCandidate]);
    const cipher = new InMemoryEnvelopeCipher();
    const strategy = new CryptoEraseStrategy(repo, cipher, makeLogger());

    const result = await strategy.execute(entry, {
      now: NOW, batchSize: 10, interBatchPauseMs: 0, dryRun: false, correlationId: "c2", maxBatches: 10,
    });

    expect(result.status).toBe("success");
    expect(result.keysDestroyed).toBe(1);
    expect(repo.nullifyWrappedDek).toHaveBeenCalledWith("booking_travelers", ["row-1"]);
  });

  it("skips rows that already have null wrapped_dek (idempotent)", async () => {
    const alreadyErased: ErasureCandidate = { ...fakeCandidate, wrappedDek: null, dekKeyId: null };
    const repo = makeRepo([alreadyErased]);
    const cipher = new InMemoryEnvelopeCipher();
    const strategy = new CryptoEraseStrategy(repo, cipher, makeLogger());

    const result = await strategy.execute(entry, {
      now: NOW, batchSize: 10, interBatchPauseMs: 0, dryRun: false, correlationId: "c3", maxBatches: 10,
    });

    expect(result.keysDestroyed).toBe(0);
    expect(repo.nullifyWrappedDek).not.toHaveBeenCalled();
  });
});
