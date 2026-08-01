/**
 * Unit tests for coverage-gate.ts — WO-084.
 *
 * Covers:
 *   - parseCoverageSummary: valid JSON, invalid JSON, non-object JSON
 *   - findDomainFiles: filters by src/domain/, excludes "total" key
 *   - aggregateStatements: sum across files, handles missing entries
 *   - runGate: passes above threshold, fails below threshold,
 *     no domain files (treated as pass), zero total statements
 *   - Fixture files: above-threshold, below-threshold, no-domain-files
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  DEFAULT_THRESHOLD,
  parseCoverageSummary,
  findDomainFiles,
  aggregateStatements,
  runGate,
  type CoverageSummary,
} from "./coverage-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMetric(total: number, covered: number) {
  return { total, covered, skipped: 0, pct: total === 0 ? 100 : Math.floor((covered / total) * 100) };
}

function makeSummary(files: Record<string, { total: number; covered: number }>): CoverageSummary {
  const summary: CoverageSummary = {
    total: {
      lines: makeMetric(0, 0),
      statements: makeMetric(0, 0),
      functions: makeMetric(0, 0),
      branches: makeMetric(0, 0),
    },
  };
  for (const [path, { total, covered }] of Object.entries(files)) {
    summary[path] = {
      lines: makeMetric(total, covered),
      statements: makeMetric(total, covered),
      functions: makeMetric(total, covered),
      branches: makeMetric(total, covered),
    };
  }
  return summary;
}

// ── DEFAULT_THRESHOLD ─────────────────────────────────────────────────────────

describe("DEFAULT_THRESHOLD", () => {
  it("is 60", () => {
    expect(DEFAULT_THRESHOLD).toBe(60);
  });
});

// ── parseCoverageSummary ──────────────────────────────────────────────────────

describe("parseCoverageSummary", () => {
  it("parses a minimal valid summary", () => {
    const raw = JSON.stringify({
      total: {
        lines: makeMetric(100, 80),
        statements: makeMetric(100, 80),
        functions: makeMetric(10, 8),
        branches: makeMetric(20, 15),
      },
    });
    const summary = parseCoverageSummary(raw);
    expect(summary["total"]).toBeDefined();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseCoverageSummary("{ not valid")).toThrow(/not valid JSON/i);
  });

  it("throws on a JSON array", () => {
    expect(() => parseCoverageSummary("[]")).toThrow(/must be a JSON object/i);
  });

  it("throws on a JSON string", () => {
    expect(() => parseCoverageSummary('"string"')).toThrow(/must be a JSON object/i);
  });
});

// ── findDomainFiles ───────────────────────────────────────────────────────────

describe("findDomainFiles", () => {
  it("finds files with src/domain/ in the path", () => {
    const summary = makeSummary({
      "/app/src/domain/LoginService.ts": { total: 100, covered: 80 },
      "/app/src/routes/auth.ts": { total: 50, covered: 40 },
    });
    const files = findDomainFiles(summary);
    expect(files).toContain("/app/src/domain/LoginService.ts");
    expect(files).not.toContain("/app/src/routes/auth.ts");
  });

  it("excludes the 'total' key", () => {
    const summary = makeSummary({
      "/app/src/domain/Foo.ts": { total: 50, covered: 40 },
    });
    const files = findDomainFiles(summary);
    expect(files).not.toContain("total");
  });

  it("returns empty array when no domain files are present", () => {
    const summary = makeSummary({
      "/app/src/routes/auth.ts": { total: 50, covered: 40 },
      "/app/src/adapters/db.ts": { total: 30, covered: 25 },
    });
    expect(findDomainFiles(summary)).toHaveLength(0);
  });

  it("matches paths with domain/ at various positions", () => {
    const summary = makeSummary({
      "src/domain/Foo.ts": { total: 10, covered: 8 },
      "services/auth-service/src/domain/Bar.ts": { total: 20, covered: 16 },
    });
    const files = findDomainFiles(summary);
    expect(files).toContain("src/domain/Foo.ts");
    expect(files).toContain("services/auth-service/src/domain/Bar.ts");
  });

  it("does NOT match a file named 'domain.ts' (not a directory segment)", () => {
    const summary = makeSummary({
      "src/domain.ts": { total: 10, covered: 8 },
    });
    expect(findDomainFiles(summary)).toHaveLength(0);
  });
});

// ── aggregateStatements ───────────────────────────────────────────────────────

describe("aggregateStatements", () => {
  it("sums total and covered statements across multiple files", () => {
    const summary = makeSummary({
      "src/domain/A.ts": { total: 100, covered: 80 },
      "src/domain/B.ts": { total: 50, covered: 30 },
    });
    const { total, covered } = aggregateStatements(summary, [
      "src/domain/A.ts",
      "src/domain/B.ts",
    ]);
    expect(total).toBe(150);
    expect(covered).toBe(110);
  });

  it("returns zero for an empty file list", () => {
    const summary = makeSummary({});
    const { total, covered } = aggregateStatements(summary, []);
    expect(total).toBe(0);
    expect(covered).toBe(0);
  });

  it("skips files that are not in the summary", () => {
    const summary = makeSummary({
      "src/domain/A.ts": { total: 100, covered: 80 },
    });
    const { total, covered } = aggregateStatements(summary, [
      "src/domain/A.ts",
      "src/domain/MISSING.ts",
    ]);
    expect(total).toBe(100);
    expect(covered).toBe(80);
  });
});

// ── runGate ───────────────────────────────────────────────────────────────────

describe("runGate — passes above threshold", () => {
  it("passes when coverage is exactly at threshold", () => {
    const summary = makeSummary({
      "src/domain/Foo.ts": { total: 100, covered: 60 },
    });
    const result = runGate(summary, 60);
    expect(result.passed).toBe(true);
    expect(result.pct).toBe(60);
  });

  it("passes when coverage is above threshold", () => {
    const summary = makeSummary({
      "src/domain/Foo.ts": { total: 100, covered: 85 },
    });
    const result = runGate(summary, 60);
    expect(result.passed).toBe(true);
    expect(result.pct).toBe(85);
  });

  it("reports correct file count", () => {
    const summary = makeSummary({
      "src/domain/A.ts": { total: 50, covered: 40 },
      "src/domain/B.ts": { total: 50, covered: 40 },
    });
    const result = runGate(summary, 60);
    expect(result.fileCount).toBe(2);
  });

  it("uses DEFAULT_THRESHOLD when none specified", () => {
    const summary = makeSummary({
      "src/domain/A.ts": { total: 100, covered: 70 },
    });
    const result = runGate(summary);
    expect(result.threshold).toBe(DEFAULT_THRESHOLD);
    expect(result.passed).toBe(true);
  });
});

describe("runGate — fails below threshold", () => {
  it("fails when coverage is below threshold", () => {
    const summary = makeSummary({
      "src/domain/Foo.ts": { total: 100, covered: 50 },
    });
    const result = runGate(summary, 60);
    expect(result.passed).toBe(false);
    expect(result.pct).toBe(50);
  });

  it("fails with custom threshold", () => {
    const summary = makeSummary({
      "src/domain/Foo.ts": { total: 100, covered: 74 },
    });
    const result = runGate(summary, 75);
    expect(result.passed).toBe(false);
  });

  it("reports total and covered counts on failure", () => {
    const summary = makeSummary({
      "src/domain/X.ts": { total: 200, covered: 80 },
    });
    const result = runGate(summary, 60);
    expect(result.total).toBe(200);
    expect(result.covered).toBe(80);
    expect(result.passed).toBe(false);
  });
});

describe("runGate — edge cases", () => {
  it("treats zero domain statements as 100% coverage (no domain code to gate)", () => {
    const summary = makeSummary({
      "src/domain/Empty.ts": { total: 0, covered: 0 },
    });
    const result = runGate(summary, 60);
    expect(result.passed).toBe(true);
    expect(result.pct).toBe(100);
  });

  it("returns fileCount=0 and passes when no domain files exist", () => {
    const summary = makeSummary({
      "src/routes/auth.ts": { total: 100, covered: 20 },
    });
    const result = runGate(summary, 60);
    expect(result.fileCount).toBe(0);
    // pct is 100 when total is 0
    expect(result.passed).toBe(true);
  });
});

// ── Fixture files ─────────────────────────────────────────────────────────────

describe("runGate — coverage-above-threshold.json fixture", () => {
  it("passes the gate", () => {
    const raw = readFileSync(join(FIXTURES, "coverage-above-threshold.json"), "utf-8");
    const summary = parseCoverageSummary(raw);
    const result = runGate(summary, 60);
    expect(result.passed).toBe(true);
    expect(result.pct).toBeGreaterThanOrEqual(60);
  });
});

describe("runGate — coverage-below-threshold.json fixture", () => {
  it("fails the gate", () => {
    const raw = readFileSync(join(FIXTURES, "coverage-below-threshold.json"), "utf-8");
    const summary = parseCoverageSummary(raw);
    const result = runGate(summary, 60);
    expect(result.passed).toBe(false);
    expect(result.pct).toBeLessThan(60);
  });
});

describe("runGate — coverage-no-domain-files.json fixture", () => {
  it("returns fileCount=0 (no domain files to gate)", () => {
    const raw = readFileSync(join(FIXTURES, "coverage-no-domain-files.json"), "utf-8");
    const summary = parseCoverageSummary(raw);
    const result = runGate(summary, 60);
    expect(result.fileCount).toBe(0);
  });
});
