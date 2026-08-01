#!/usr/bin/env tsx
/**
 * coverage-gate.ts — Domain-layer statement coverage gate (WO-084).
 *
 * Reads an Istanbul/v8 coverage-summary.json file (produced by vitest with
 * --coverage --coverage.reporter=json-summary) and fails the build when the
 * domain-layer (files matching src/domain/**) statement coverage falls below
 * a configurable threshold (default: 60%).
 *
 * Coverage summary format:
 *   {
 *     "total": { "statements": { "total": N, "covered": M, "pct": P }, ... },
 *     "/abs/path/to/src/domain/foo.ts": {
 *       "statements": { "total": N, "covered": M, "pct": P }, ...
 *     }
 *   }
 *
 * Usage:
 *   tsx tools/ci/coverage-gate.ts --summary <path> [--threshold <pct>]
 *
 * Exit codes:
 *   0 — coverage meets or exceeds the threshold
 *   1 — coverage below threshold
 *   2 — usage / I/O / parse error
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface FileCoverage {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

export type CoverageSummary = Record<string, FileCoverage>;

export interface GateResult {
  /** Whether the gate passed. */
  passed: boolean;
  /** Aggregated statement coverage percentage across domain files (0–100). */
  pct: number;
  /** Total domain-layer statements. */
  total: number;
  /** Covered domain-layer statements. */
  covered: number;
  /** Number of domain files evaluated. */
  fileCount: number;
  /** Threshold that was applied. */
  threshold: number;
  /** File paths that contributed to the aggregate. */
  files: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default statement coverage threshold for the domain layer (%). */
export const DEFAULT_THRESHOLD = 60;

/**
 * Pattern that identifies domain-layer files in the coverage summary.
 * Matches any path segment equal to "domain" (e.g. "src/domain/", "/domain/").
 */
const DOMAIN_PATH_RE = /(?:^|\/)domain\//;

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Parse and lightly validate the raw coverage summary JSON string.
 * Throws a descriptive Error on invalid input.
 */
export function parseCoverageSummary(raw: string): CoverageSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Coverage summary is not valid JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Coverage summary must be a JSON object");
  }
  return parsed as CoverageSummary;
}

/**
 * Identify which keys in the summary represent domain-layer files.
 * The key "total" is always excluded (it is the aggregate row, not a file).
 */
export function findDomainFiles(summary: CoverageSummary): string[] {
  return Object.keys(summary).filter(
    (key) => key !== "total" && DOMAIN_PATH_RE.test(key)
  );
}

/**
 * Aggregate statement coverage across a set of files in the summary.
 * Returns { total, covered } statement counts.
 */
export function aggregateStatements(
  summary: CoverageSummary,
  files: string[]
): { total: number; covered: number } {
  let total = 0;
  let covered = 0;
  for (const file of files) {
    const entry = summary[file];
    if (!entry) continue;
    total += entry.statements.total;
    covered += entry.statements.covered;
  }
  return { total, covered };
}

/**
 * Run the coverage gate against a parsed summary.
 *
 * @param summary    Parsed coverage-summary.json object.
 * @param threshold  Minimum required statement coverage percentage (default 60).
 */
export function runGate(
  summary: CoverageSummary,
  threshold: number = DEFAULT_THRESHOLD
): GateResult {
  const files = findDomainFiles(summary);
  const { total, covered } = aggregateStatements(summary, files);

  const pct = total === 0 ? 100 : Math.floor((covered / total) * 100);

  return {
    passed: pct >= threshold,
    pct,
    total,
    covered,
    fileCount: files.length,
    threshold,
    files,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let summaryPath: string | undefined;
  let threshold = DEFAULT_THRESHOLD;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--summary" && args[i + 1]) {
      summaryPath = resolve(args[++i] as string);
    } else if (args[i] === "--threshold" && args[i + 1]) {
      const t = Number(args[++i]);
      if (!Number.isFinite(t) || t < 0 || t > 100) {
        console.error("[coverage-gate] ERROR: --threshold must be a number between 0 and 100");
        process.exit(2);
      }
      threshold = t;
    }
  }

  if (!summaryPath) {
    console.error("[coverage-gate] ERROR: --summary <path> is required");
    process.exit(2);
  }

  let raw: string;
  try {
    raw = readFileSync(summaryPath, "utf-8");
  } catch (err) {
    console.error(`[coverage-gate] ERROR: Cannot read summary file ${summaryPath}: ${String(err)}`);
    process.exit(2);
  }

  let summary: CoverageSummary;
  try {
    summary = parseCoverageSummary(raw);
  } catch (err) {
    console.error(`[coverage-gate] ERROR: ${String(err)}`);
    process.exit(2);
  }

  const result = runGate(summary, threshold);

  if (result.fileCount === 0) {
    console.warn(
      "[coverage-gate] WARN: No domain-layer files found in coverage summary. " +
      "Ensure vitest is configured with coverage.include that captures src/domain/**. " +
      "Treating as 100% (no domain code to gate)."
    );
    process.exit(0);
  }

  const label = result.passed ? "PASSED" : "FAILED";
  console.log(
    `[coverage-gate] ${label} — domain statements: ${result.covered}/${result.total} (${result.pct}%) ` +
    `across ${result.fileCount} file(s) — threshold: ${result.threshold}%`
  );

  if (!result.passed) {
    console.error(
      `[coverage-gate] Domain-layer coverage ${result.pct}% is below the ${result.threshold}% gate. ` +
      "Add unit tests for uncovered domain logic and re-run."
    );
    process.exit(1);
  }

  process.exit(0);
}

if (
  process.argv[1]?.endsWith("coverage-gate.ts") ||
  process.argv[1]?.endsWith("coverage-gate.js")
) {
  main().catch((err) => {
    console.error("[coverage-gate] Fatal:", err);
    process.exit(2);
  });
}
