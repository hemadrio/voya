/**
 * Integration tests for the full PurgeOrchestrator stack.
 *
 * Uses:
 * - An in-memory InMemoryPurgeRepository (no real DB)
 * - InMemoryEnvelopeCipher for crypto-erasure verification
 * - SpyPurgeMetrics for metric assertion
 * - Fixture generator producing boundary-dated rows
 *
 * These tests assert the correctness of the full orchestration pipeline:
 * strategy dispatch, erasure isolation, audit exclusion, dry-run, and
 * boundary-date purge predicate — without requiring a real Postgres container.
 *
 * For Postgres-container tests see the runbook in docs/testing/purge-integration.md.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PurgeOrchestrator,
  SpyPurgeMetrics,
  PhysicalDeleteStrategy,
  CryptoEraseStrategy,
  PseudonymiseActorStrategy,
  ConversationSweepStrategy,
  buildRetentionConfig,
  type PurgeRepositoryPort,
  type PurgeLogger,
  type ErasureCandidate,
  type PurgeRunRecord,
  type QuarantineEntry,
  type CategoryPurgeStrategy,
} from "../../src/index.js";
import { InMemoryEnvelopeCipher } from "@travel/crypto";
import { CLASSIFICATION_REGISTER } from "@travel/contracts/retention";
import type { ClassificationRegister } from "@travel/contracts/retention";
import {
  generatePhysicalDeleteFixtures,
  generateCryptoEraseFixtures,
} from "../fixtures/boundaryDateFixtures.js";

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-07-01T02:00:00.000Z");
const fixedClock = { now: () => new Date(FIXED_NOW) };

// ---------------------------------------------------------------------------
// In-memory repository
// ---------------------------------------------------------------------------

interface StoredRow {
  id: string;
  purge_after: Date | null;
  wrapped_dek?: Buffer | null;
  dek_key_id?: string | null;
  subject_id?: string;
  booking_id?: string;
  pseudonymised?: boolean;
}

class InMemoryPurgeRepository implements PurgeRepositoryPort {
  private tables = new Map<string, Map<string, StoredRow>>();
  private leases = new Map<string, Date>(); // key → expiry
  purgeRunLog: PurgeRunRecord[] = [];
  quarantineLog: QuarantineEntry[] = [];

  seed(table: string, rows: StoredRow[]): void {
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    const map = this.tables.get(table)!;
    for (const row of rows) map.set(row.id, { ...row });
  }

  getRow(table: string, id: string): StoredRow | undefined {
    return this.tables.get(table)?.get(id);
  }

  getAllRows(table: string): StoredRow[] {
    return [...(this.tables.get(table)?.values() ?? [])];
  }

  async countExpired(table: string, now: Date): Promise<number> {
    const rows = this.getAllRows(table);
    return rows.filter((r) => r.purge_after !== null && r.purge_after <= now).length;
  }

  async deleteBatch(table: string, batchSize: number, now: Date): Promise<number> {
    const map = this.tables.get(table);
    if (!map) return 0;
    let deleted = 0;
    for (const [id, row] of map) {
      if (deleted >= batchSize) break;
      if (row.purge_after !== null && row.purge_after <= now) {
        map.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async fetchErasureCandidates(table: string, batchSize: number, now: Date): Promise<ErasureCandidate[]> {
    const rows = this.getAllRows(table)
      .filter((r) => r.purge_after !== null && r.purge_after <= now)
      .slice(0, batchSize);
    return rows.map((r) => ({
      id: r.id,
      subjectId: r.subject_id ?? r.id,
      wrappedDek: r.wrapped_dek ?? null,
      dekKeyId: r.dek_key_id ?? null,
      bookingId: r.booking_id ?? "",
    }));
  }

  async nullifyWrappedDek(table: string, ids: string[]): Promise<number> {
    const map = this.tables.get(table);
    if (!map) return 0;
    let count = 0;
    for (const id of ids) {
      const row = map.get(id);
      if (row) {
        row.wrapped_dek = null;
        row.dek_key_id = null;
        count++;
      }
    }
    return count;
  }

  async pseudonymiseActor(table: string, _actorIds: string[]): Promise<number> {
    const map = this.tables.get(table);
    if (!map) return 0;
    let count = 0;
    for (const row of map.values()) {
      if (row.purge_after !== null && !row.pseudonymised) {
        row.pseudonymised = true;
        count++;
      }
    }
    return count;
  }

  async deleteConversationKeys(_cutoff: Date, _batchSize: number): Promise<number> {
    return 0; // Redis sweep — no-op in unit test
  }

  async recordPurgeRun(run: PurgeRunRecord): Promise<void> {
    this.purgeRunLog.push({ ...run });
  }

  async acquireLease(leaseKey: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.leases.get(leaseKey);
    if (existing && existing > new Date()) return false;
    this.leases.set(leaseKey, new Date(Date.now() + ttlSeconds * 1000));
    return true;
  }

  async releaseLease(leaseKey: string): Promise<void> {
    this.leases.delete(leaseKey);
  }

  async getDbLoadFactor(): Promise<number> {
    return 0; // healthy — no deferral in tests
  }

  async quarantine(entry: QuarantineEntry): Promise<void> {
    this.quarantineLog.push({ ...entry });
  }
}

// ---------------------------------------------------------------------------
// Logger spy
// ---------------------------------------------------------------------------

function makeLogger(): PurgeLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// ---------------------------------------------------------------------------
// Helpers to build orchestrator
// ---------------------------------------------------------------------------

const retentionConfig = buildRetentionConfig({
  accountIdentityDays: 30,
  transactionYears: 7,
  identityDocumentDays: 90,
  sessionDays: 7,
  itineraryYears: 7,
  preferenceDays: 365,
  conversationDays: 90,
  auditDays: 365,
});

function buildOrchestrator(
  repo: InMemoryPurgeRepository,
  cipher: InMemoryEnvelopeCipher,
  metrics: SpyPurgeMetrics,
  register: ClassificationRegister = CLASSIFICATION_REGISTER,
): PurgeOrchestrator {
  const logger = makeLogger();
  const strategies = new Map<string, CategoryPurgeStrategy>([
    ["physical_delete", new PhysicalDeleteStrategy(repo, logger)],
    ["crypto_erasure", new CryptoEraseStrategy(repo, cipher, logger)],
    ["pseudonymisation", new PseudonymiseActorStrategy(repo, logger)],
    ["conversation_sweep", new ConversationSweepStrategy(repo, retentionConfig, logger)],
  ]);
  return new PurgeOrchestrator(
    register,
    strategies,
    repo,
    fixedClock,
    metrics,
    logger,
    { batchSize: 100, interBatchPauseMs: 0, maxBatchesPerCategory: 100, loadThreshold: 0.9, leaseTtlSeconds: 3600 },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PurgeOrchestrator — integration (in-memory)", () => {
  let repo: InMemoryPurgeRepository;
  let cipher: InMemoryEnvelopeCipher;
  let metrics: SpyPurgeMetrics;

  beforeEach(() => {
    repo = new InMemoryPurgeRepository();
    cipher = new InMemoryEnvelopeCipher();
    metrics = new SpyPurgeMetrics();
  });

  // ─── Dry-run: no mutations ──────────────────────────────────────────────

  describe("dry-run mode", () => {
    it("reports candidate counts per category but performs zero mutations", async () => {
      const physicalRows = generatePhysicalDeleteFixtures(FIXED_NOW);
      repo.seed("users", physicalRows.map((r) => ({ id: r.id, purge_after: r.purge_after })));

      const orchestrator = buildOrchestrator(repo, cipher, metrics);
      const result = await orchestrator.run({ dryRun: true, correlationId: "dry-1" });

      expect(result.hasFailures).toBe(false);

      // All categories are "skipped" in dry-run
      for (const cat of result.categories) {
        if (cat.status !== "excluded") {
          expect(cat.status).toBe("skipped");
          expect(cat.purged).toBe(0);
        }
      }

      // No rows deleted
      const remaining = repo.getAllRows("users");
      expect(remaining).toHaveLength(physicalRows.length);
    });

    it("records zero purge run audit entries in dry-run mode", async () => {
      repo.seed("users", generatePhysicalDeleteFixtures(FIXED_NOW).map((r) => ({ id: r.id, purge_after: r.purge_after })));

      const orchestrator = buildOrchestrator(repo, cipher, metrics);
      await orchestrator.run({ dryRun: true, correlationId: "dry-audit" });

      expect(repo.purgeRunLog).toHaveLength(0);
    });
  });

  // ─── Physical delete boundary predicate ───────────────────────────────

  describe("physical delete — boundary-date predicate", () => {
    it("purges rows where purge_after <= now and retains rows where purge_after > now", async () => {
      const fixtures = generatePhysicalDeleteFixtures(FIXED_NOW);
      repo.seed("users", fixtures.map((r) => ({ id: r.id, purge_after: r.purge_after })));

      // Use a minimal register with just the users entry
      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "users.identity")!],
      };

      const orchestrator = buildOrchestrator(repo, cipher, metrics, minimalRegister);
      const result = await orchestrator.run({ dryRun: false, correlationId: "phys-1" });

      expect(result.hasFailures).toBe(false);

      // Check each fixture row matches expected outcome
      for (const row of fixtures) {
        const remaining = repo.getRow("users", row.id);
        if (row.expectedOutcome === "purged") {
          expect(remaining, `Row "${row.label}" should be purged`).toBeUndefined();
        } else {
          expect(remaining, `Row "${row.label}" should be retained`).toBeDefined();
        }
      }
    });

    it("purge_after exactly equal to now is purged (boundary inclusive)", async () => {
      const exactly = { id: "boundary-1", purge_after: new Date(FIXED_NOW) };
      repo.seed("users", [exactly]);

      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "users.identity")!],
      };

      const orchestrator = buildOrchestrator(repo, cipher, metrics, minimalRegister);
      await orchestrator.run({ dryRun: false, correlationId: "boundary" });

      expect(repo.getRow("users", "boundary-1")).toBeUndefined();
    });
  });

  // ─── Crypto erasure isolation ──────────────────────────────────────────

  describe("crypto erasure — per-subject isolation", () => {
    it("nullifies wrapped_dek for expired subjects while retaining unexpired subjects", async () => {
      const fixtures = generateCryptoEraseFixtures(FIXED_NOW);
      repo.seed(
        "booking_travelers",
        fixtures.map((r) => ({
          id: r.id,
          purge_after: r.purge_after,
          wrapped_dek: r.wrapped_dek,
          dek_key_id: r.dek_key_id,
          subject_id: r.subject_id,
          booking_id: r.booking_id,
        })),
      );

      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "booking_travelers.identity_documents")!],
      };

      const orchestrator = buildOrchestrator(repo, cipher, metrics, minimalRegister);
      const result = await orchestrator.run({ dryRun: false, correlationId: "crypto-1" });

      expect(result.hasFailures).toBe(false);

      // Expired rows: wrapped_dek should be null (erased)
      for (const fixture of fixtures) {
        const row = repo.getRow("booking_travelers", fixture.id);
        if (fixture.expectedOutcome === "purged" && fixture.wrapped_dek !== null) {
          // Row is retained but DEK is nullified
          expect(row, `Row "${fixture.label}" should still exist`).toBeDefined();
          expect(row?.wrapped_dek, `Row "${fixture.label}" should have wrapped_dek nullified`).toBeNull();
        } else if (fixture.expectedOutcome === "retained") {
          expect(row, `Row "${fixture.label}" should be retained`).toBeDefined();
          expect(row?.wrapped_dek, `Row "${fixture.label}" wrapped_dek must remain`).not.toBeNull();
        }
      }
    });

    it("keysDestroyed metric equals number of non-null wrapped_deks processed", async () => {
      const fixtures = generateCryptoEraseFixtures(FIXED_NOW);
      repo.seed(
        "booking_travelers",
        fixtures.map((r) => ({
          id: r.id,
          purge_after: r.purge_after,
          wrapped_dek: r.wrapped_dek,
          dek_key_id: r.dek_key_id,
          subject_id: r.subject_id,
          booking_id: r.booking_id,
        })),
      );

      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "booking_travelers.identity_documents")!],
      };

      const orchestrator = buildOrchestrator(repo, cipher, metrics, minimalRegister);
      await orchestrator.run({ dryRun: false, correlationId: "crypto-keys" });

      // Rows with non-null wrapped_dek that are expired: 2 (boundary + past)
      const keysDestroyedEntries = metrics.keysDestroyed.filter((m) => m.category === "Traveler identity documents");
      const totalKeys = keysDestroyedEntries.reduce((sum, m) => sum + m.count, 0);
      expect(totalKeys).toBe(2); // boundary + past; future and null are skipped
    });
  });

  // ─── Audit exclusion ───────────────────────────────────────────────────

  describe("audit exclusion", () => {
    it("booking_audit_log entries are marked excluded and never deleted", async () => {
      const auditRow = { id: "audit-1", purge_after: new Date(FIXED_NOW.getTime() - 1_000) };
      repo.seed("booking_audit_log", [auditRow]);

      const orchestrator = buildOrchestrator(repo, cipher, metrics);
      const result = await orchestrator.run({ dryRun: false, correlationId: "audit-excl" });

      // Audit entries should show "excluded" status
      const auditCats = result.categories.filter((c) => c.table === "booking_audit_log");
      for (const cat of auditCats) {
        expect(["excluded", "skipped"]).toContain(cat.status);
        expect(cat.purged).toBe(0);
      }

      // Row must still exist
      expect(repo.getRow("booking_audit_log", "audit-1")).toBeDefined();
    });
  });

  // ─── Configuration validation (AC7) ───────────────────────────────────

  describe("configuration validation", () => {
    it("buildRetentionConfig rejects invalid config (integration guard)", () => {
      // loadRetentionConfig reads env vars — validated exhaustively in retentionConfig.test.ts.
      // Here we confirm the config schema rejects an out-of-range value.
      const { buildRetentionConfig: build } = await import("../../src/retentionConfig.js");
      expect(() =>
        build({
          accountIdentityDays: 30,
          transactionYears: 7,
          identityDocumentDays: 90,
          sessionDays: 7,
          itineraryYears: 7,
          preferenceDays: 365,
          conversationDays: 90,
          auditDays: 1, // too low — must be >= 365
        }),
      ).toThrow();
    });
  });

  // ─── Run lease prevents concurrent runs ────────────────────────────────

  describe("run lease", () => {
    it("second run returns empty categories when lease is still held", async () => {
      const orchestrator = buildOrchestrator(repo, cipher, metrics);

      // First run acquires and holds the lease
      const repoWithStickyLease: PurgeRepositoryPort = {
        ...repo,
        acquireLease: async (key) => {
          // First call succeeds, all subsequent fail
          const alreadyReleased = !repo["leases"].has(key) || repo["leases"].get(key)! <= new Date();
          if (alreadyReleased) {
            repo["leases"].set(key, new Date(Date.now() + 3_600_000));
            return true;
          }
          return false;
        },
      };

      const orchestratorWithStickyLease = buildOrchestrator(
        repoWithStickyLease as InMemoryPurgeRepository,
        cipher,
        new SpyPurgeMetrics(),
      );

      // Seed lease manually
      repo["leases"].set("purge:global", new Date(Date.now() + 3_600_000));

      const result = await orchestratorWithStickyLease.run({ dryRun: false, correlationId: "lease-2" });

      expect(result.categories).toHaveLength(0);
    });
  });

  // ─── Metrics emitted correctly (AC11) ──────────────────────────────────

  describe("metrics", () => {
    it("recordRunStart and recordRunComplete are called exactly once per run", async () => {
      const orchestrator = buildOrchestrator(repo, cipher, metrics);
      await orchestrator.run({ dryRun: true, correlationId: "metrics-1" });

      expect(metrics.runStarts).toBe(1);
      expect(metrics.runCompletes).toHaveLength(1);
      expect(metrics.runCompletes[0]?.dryRun).toBe(true);
    });

    it("failure metric is incremented when a strategy throws", async () => {
      const throwingRepo: PurgeRepositoryPort = {
        ...repo,
        countExpired: async () => { throw new Error("DB down"); },
      };

      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "users.identity")!],
      };

      const orchestrator = buildOrchestrator(throwingRepo as InMemoryPurgeRepository, cipher, metrics, minimalRegister);
      const result = await orchestrator.run({ dryRun: false, correlationId: "fail-metric" });

      expect(result.hasFailures).toBe(true);
      expect(metrics.failures).toContain("Account identity");
    });
  });

  // ─── Audit trail records (AC13) ────────────────────────────────────────

  describe("audit trail", () => {
    it("writes a purge_runs record for each category with purged > 0 in apply mode", async () => {
      const expiredRow = { id: "user-1", purge_after: new Date(FIXED_NOW.getTime() - 1_000) };
      repo.seed("users", [expiredRow]);

      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "users.identity")!],
      };

      const orchestrator = buildOrchestrator(repo, cipher, metrics, minimalRegister);
      await orchestrator.run({ dryRun: false, correlationId: "audit-trail-1" });

      expect(repo.purgeRunLog).toHaveLength(1);
      expect(repo.purgeRunLog[0]).toMatchObject({
        category: "Account identity",
        purged: 1,
        dryRun: false,
        correlationId: "audit-trail-1",
      });
    });
  });

  // ─── Load guard (AC10) ─────────────────────────────────────────────────

  describe("load guard", () => {
    it("skips category when DB load exceeds threshold", async () => {
      const highLoadRepo: PurgeRepositoryPort = {
        ...repo,
        getDbLoadFactor: async () => 0.95,
      };

      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "users.identity")!],
      };

      const orchestrator = buildOrchestrator(highLoadRepo as InMemoryPurgeRepository, cipher, metrics, minimalRegister);
      const result = await orchestrator.run({ dryRun: false, correlationId: "load-1" });

      expect(result.categories[0]?.status).toBe("skipped");
      expect(result.hasFailures).toBe(false);
    });
  });

  // ─── Non-zero exit on failure (AC9) ────────────────────────────────────

  describe("never fail open (policy A10)", () => {
    it("hasFailures=true when any category strategy throws — non-zero exit signal", async () => {
      const crashingRepo: PurgeRepositoryPort = {
        ...repo,
        countExpired: async () => { throw new Error("connection pool exhausted"); },
      };

      const minimalRegister: ClassificationRegister = {
        version: "test",
        description: "test",
        entries: [CLASSIFICATION_REGISTER.entries.find((e) => e.id === "users.identity")!],
      };

      const orchestrator = buildOrchestrator(crashingRepo as InMemoryPurgeRepository, cipher, metrics, minimalRegister);
      const result = await orchestrator.run({ dryRun: false, correlationId: "nfo-1" });

      expect(result.hasFailures).toBe(true);
    });
  });
});
