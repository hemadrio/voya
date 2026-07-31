/**
 * Unit tests for PartitionMaintenance.
 * Uses a fake DB client — no Postgres connection required.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createPartitionMaintenance,
  type PartitionDbClient,
  type PartitionMaintenanceLogger,
} from "../src/PartitionMaintenance.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeLogger(): PartitionMaintenanceLogger & {
  warns: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
} {
  const warns: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  return {
    warns,
    errors,
    info: vi.fn(),
    warn: vi.fn((obj) => warns.push(obj)),
    error: vi.fn((obj) => errors.push(obj)),
  };
}

function makeDb(existingPartitions: string[]): PartitionDbClient & {
  execCalls: string[];
} {
  const execCalls: string[] = [];
  return {
    execCalls,
    async $executeRawUnsafe(sql: string) {
      execCalls.push(sql.trim().split("\n")[0]!);
      return 0;
    },
    async $queryRawUnsafe<T>(sql: string): Promise<T[]> {
      if (sql.includes("pg_inherits")) {
        return existingPartitions.map((p) => ({ partition_name: p })) as T[];
      }
      return [] as T[];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPartitionMaintenance", () => {
  it("pre-creates the next N months when partitions are absent", async () => {
    const db = makeDb([]);
    const logger = makeLogger();
    const maintenance = createPartitionMaintenance({
      db,
      logger,
      preCreateMonths: 2,
    });

    const now = new Date("2025-06-15T00:00:00Z");
    const report = await maintenance.run(now);

    // Should create current month (2025_06), plus 2 future months (2025_07, 2025_08)
    expect(report.created).toContain("booking_audit_log_2025_06");
    expect(report.created).toContain("booking_audit_log_2025_07");
    expect(report.created).toContain("booking_audit_log_2025_08");
    expect(report.errors).toHaveLength(0);
  });

  it("skips partitions that already exist", async () => {
    const db = makeDb([
      "booking_audit_log_2025_06",
      "booking_audit_log_2025_07",
    ]);
    const logger = makeLogger();
    const maintenance = createPartitionMaintenance({
      db,
      logger,
      preCreateMonths: 1,
    });

    const now = new Date("2025-06-01T00:00:00Z");
    const report = await maintenance.run(now);

    expect(report.alreadyExisted).toContain("booking_audit_log_2025_06");
    expect(report.alreadyExisted).toContain("booking_audit_log_2025_07");
    expect(report.created).toHaveLength(0);
  });

  it("emits a warning when next month partition is missing", async () => {
    const db = makeDb(["booking_audit_log_2025_06"]);
    const logger = makeLogger();
    const maintenance = createPartitionMaintenance({
      db,
      logger,
      preCreateMonths: 0, // deliberately not pre-creating future months
    });

    const now = new Date("2025-06-01T00:00:00Z");
    const report = await maintenance.run(now);

    // Next month (2025_07) is missing because preCreateMonths=0
    // The partition IS created in the loop (i=0 is current, i=1 is next+0)
    // With preCreateMonths=0, the loop runs for i in [0], creating only current.
    // The check for next month would find it missing.
    expect(report.missingNextPartition).toBe(true);
    expect(logger.warns.some((w) => w["event"] === "partition.missing_next")).toBe(true);
  });

  it("detaches partitions older than the hot boundary", async () => {
    // Hot boundary = 12 months; now = 2025-06 → cold boundary = 2024-06
    // Partition 2024_03 is 15 months old → cold
    const db = makeDb([
      "booking_audit_log_2024_03",
      "booking_audit_log_2024_05",
      "booking_audit_log_2024_07", // 11 months old, still hot
      "booking_audit_log_2025_06",
    ]);
    const logger = makeLogger();
    const maintenance = createPartitionMaintenance({
      db,
      logger,
      preCreateMonths: 1,
      hotBoundaryMonths: 12,
    });

    const now = new Date("2025-06-15T00:00:00Z");
    const report = await maintenance.run(now);

    // 2024_03 (15 months ago) and 2024_05 (13 months ago) should be cold
    expect(report.movedToCold).toContain("booking_audit_log_2024_03");
    expect(report.movedToCold).toContain("booking_audit_log_2024_05");
    // 2024_07 (11 months ago) is still hot
    expect(report.movedToCold).not.toContain("booking_audit_log_2024_07");
  });

  it("handles DB errors gracefully and includes them in the report", async () => {
    const db = makeDb([]);
    // Make $executeRawUnsafe throw on CREATE
    vi.spyOn(db, "$executeRawUnsafe").mockRejectedValue(new Error("DB connection lost"));

    const logger = makeLogger();
    const maintenance = createPartitionMaintenance({ db, logger, preCreateMonths: 1 });
    const now = new Date("2025-06-01T00:00:00Z");
    const report = await maintenance.run(now);

    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toMatch(/DB connection lost/);
  });

  it("year boundary: month 12 pre-creates month 1 of next year", async () => {
    const db = makeDb([]);
    const logger = makeLogger();
    const maintenance = createPartitionMaintenance({
      db,
      logger,
      preCreateMonths: 2,
    });

    const now = new Date("2025-12-01T00:00:00Z");
    const report = await maintenance.run(now);

    expect(report.created).toContain("booking_audit_log_2025_12");
    expect(report.created).toContain("booking_audit_log_2026_01");
    expect(report.created).toContain("booking_audit_log_2026_02");
  });
});
