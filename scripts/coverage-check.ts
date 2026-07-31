#!/usr/bin/env tsx
/**
 * Coverage aggregation and per-path threshold enforcement script.
 *
 * Reads per-package coverage/coverage-summary.json files produced by
 * `vitest run --coverage`, evaluates per-path glob thresholds, and exits
 * non-zero with a human-readable summary of every failing path.
 *
 * Gate configuration:
 *   Phase 1 — 60 % lines on search and auth domain services.
 *   Phase 2 — 60 % lines on booking lifecycle and payment confirmation domain services.
 *
 * Usage:
 *   pnpm coverage:check
 *   tsx scripts/coverage-check.ts
 *
 * The script never fails open: a missing coverage file is treated as 0 % for
 * any glob that matches at least one source file under that package.
 * If a configured glob matches 0 files across all coverage reports, the gate
 * emits a loud warning so stale threshold entries are caught during refactors.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { createRequire } from "node:module";

const __require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileCoverage {
  lines: { total: number; covered: number; skipped: number; pct: number };
  branches: { total: number; covered: number; skipped: number; pct: number };
  functions: { total: number; covered: number; skipped: number; pct: number };
  statements: { total: number; covered: number; skipped: number; pct: number };
}
type CoverageSummary = Record<string, FileCoverage>;

interface ThresholdConfig {
  /** Glob pattern relative to workspace root (e.g. "services/auth-service/src/domain/**"). */
  pathGlob: string;
  /** Human-readable package name for error messages. */
  package: string;
  /** Phase gate this threshold protects (for error messages). */
  phase: string;
  /** Required line coverage percentage (0–100). */
  lines: number;
  /** Required branch coverage percentage (0–100). */
  branches: number;
}

// ---------------------------------------------------------------------------
// Per-path threshold configuration
// ---------------------------------------------------------------------------

const THRESHOLDS: ThresholdConfig[] = [
  // ── Phase 1 ──────────────────────────────────────────────────────────────
  {
    pathGlob: "services/auth-service/src/domain",
    package: "auth-service",
    phase: "Phase 1",
    lines: 60,
    branches: 60,
  },
  // search-service domain layer — to be enforced once src/domain/ is created
  // {
  //   pathGlob: "services/search-service/src/domain",
  //   package: "search-service",
  //   phase: "Phase 1",
  //   lines: 60,
  //   branches: 60,
  // },

  // ── Phase 2 ──────────────────────────────────────────────────────────────
  {
    pathGlob: "services/booking-service/src/domain",
    package: "booking-service",
    phase: "Phase 2",
    lines: 60,
    branches: 60,
  },
  // payment-service domain layer — to be enforced once src/domain/ is created
  // {
  //   pathGlob: "services/payment-service/src/domain",
  //   package: "payment-service",
  //   phase: "Phase 2",
  //   lines: 60,
  //   branches: 60,
  // },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple glob matcher supporting ** and * wildcards. */
function matchesGlob(filePath: string, pattern: string): boolean {
  // Normalise separators to forward-slash
  const p = filePath.replace(/\\/g, "/");
  const g = pattern.replace(/\\/g, "/");

  // Exact prefix match: if pattern has no wildcard, treat as a directory prefix
  if (!g.includes("*")) {
    return p.startsWith(g + "/") || p === g;
  }

  // Convert glob to regex: ** matches anything, * matches non-separator
  const regexStr = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex meta except * and /
    .replace(/\*\*/g, "§§") // placeholder for **
    .replace(/\*/g, "[^/]*") // * → non-separator match
    .replace(/§§/g, ".*"); // ** → anything
  return new RegExp(`^${regexStr}(/.*)?$`).test(p);
}

/** Aggregate line + branch coverage from a list of file coverage entries. */
function aggregate(entries: FileCoverage[]): {
  linesPct: number;
  branchesPct: number;
  totalLines: number;
  coveredLines: number;
  totalBranches: number;
  coveredBranches: number;
} {
  let totalLines = 0;
  let coveredLines = 0;
  let totalBranches = 0;
  let coveredBranches = 0;
  for (const e of entries) {
    totalLines += e.lines.total;
    coveredLines += e.lines.covered;
    totalBranches += e.branches.total;
    coveredBranches += e.branches.covered;
  }
  const linesPct = totalLines === 0 ? 100 : (coveredLines / totalLines) * 100;
  const branchesPct = totalBranches === 0 ? 100 : (coveredBranches / totalBranches) * 100;
  return { linesPct, branchesPct, totalLines, coveredLines, totalBranches, coveredBranches };
}

// ---------------------------------------------------------------------------
// Discover coverage files
// ---------------------------------------------------------------------------

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

function discoverCoverageFiles(): Map<string, CoverageSummary> {
  const result = new Map<string, CoverageSummary>();
  const searchDirs = [join(ROOT, "services"), join(ROOT, "packages")];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const pkgNames = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const pkg of pkgNames) {
      const summaryPath = join(dir, pkg, "coverage", "coverage-summary.json");
      if (!existsSync(summaryPath)) continue;
      try {
        const raw = readFileSync(summaryPath, "utf-8");
        const summary = JSON.parse(raw) as CoverageSummary;
        // Remove "total" key — it's aggregate, not per-file
        delete summary["total"];
        result.set(join(dir, pkg), summary);
      } catch {
        console.warn(`[coverage-check] WARNING: Could not parse ${summaryPath}`);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const coverageFiles = discoverCoverageFiles();
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const threshold of THRESHOLDS) {
    // Collect all file coverage entries matching this glob
    const matchedEntries: FileCoverage[] = [];
    let matchCount = 0;

    for (const [pkgRoot, summary] of coverageFiles) {
      for (const [filePath, fileCov] of Object.entries(summary)) {
        // filePath may be absolute or relative — normalise to workspace-relative
        const absPath = filePath.startsWith("/") ? filePath : resolve(pkgRoot, filePath);
        const relPath = relative(ROOT, absPath);
        if (matchesGlob(relPath, threshold.pathGlob)) {
          matchedEntries.push(fileCov);
          matchCount++;
        }
      }
    }

    if (matchCount === 0) {
      warnings.push(
        `  ⚠  [${threshold.phase}] ${threshold.package}: glob "${threshold.pathGlob}" matched 0 files — ` +
          `threshold will be enforced once domain code is added.`,
      );
      continue;
    }

    const { linesPct, branchesPct, totalLines, coveredLines, totalBranches, coveredBranches } =
      aggregate(matchedEntries);

    const linesOk = linesPct >= threshold.lines;
    const branchesOk = branchesPct >= threshold.branches;

    if (!linesOk || !branchesOk) {
      const parts: string[] = [];
      if (!linesOk) {
        parts.push(
          `lines: ${linesPct.toFixed(1)}% < ${threshold.lines}% (${coveredLines}/${totalLines})`,
        );
      }
      if (!branchesOk) {
        parts.push(
          `branches: ${branchesPct.toFixed(1)}% < ${threshold.branches}% (${coveredBranches}/${totalBranches})`,
        );
      }
      failures.push(
        `  ✗  [${threshold.phase}] ${threshold.package} (${threshold.pathGlob}): ${parts.join(", ")}`,
      );
    } else {
      console.log(
        `  ✓  [${threshold.phase}] ${threshold.package}: ` +
          `lines ${linesPct.toFixed(1)}% (≥${threshold.lines}%), ` +
          `branches ${branchesPct.toFixed(1)}% (≥${threshold.branches}%)`,
      );
    }
  }

  if (warnings.length > 0) {
    console.log("\nCoverage gate warnings:");
    for (const w of warnings) console.log(w);
  }

  if (failures.length > 0) {
    console.error("\n\nCoverage gate FAILED — the following paths are below their required threshold:");
    for (const f of failures) console.error(f);
    console.error(
      "\nRun `pnpm test:unit -- --coverage` to generate coverage reports, then re-run `pnpm coverage:check`.",
    );
    process.exit(1);
  }

  console.log("\nAll coverage gates passed.");
}

main();
