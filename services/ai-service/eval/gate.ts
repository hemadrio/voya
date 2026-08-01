#!/usr/bin/env node
/**
 * CI gate command — runs the eval harness, diffs against baseline, and
 * exits non-zero on any regression (WO-063, AC9, AC10).
 *
 * Usage:
 *   npx tsx eval/gate.ts [--scenarios <dir>] [--output <dir>] [--baseline <file>]
 *
 * Baseline regeneration (NEVER runs automatically):
 *   npx tsx eval/gate.ts --regenerate-baseline
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runAllScenarios } from "./runner.js";
import { buildReport, diffAgainstBaseline, formatSummary } from "./report.js";
import { validateScenario } from "./schema.js";
import type { Report } from "./report.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SCENARIOS_DIR = join(__dirname, "scenarios");
const DEFAULT_OUTPUT_DIR = join(__dirname, "..", "eval-output");
const DEFAULT_BASELINE = join(__dirname, "baseline.json");

// ---------------------------------------------------------------------------
// Argument parsing (minimal, no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  scenariosDir: string;
  outputDir: string;
  baselineFile: string;
  regenerateBaseline: boolean;
  subset?: string;
} {
  const args: Record<string, string> = {};
  let regenerateBaseline = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--regenerate-baseline") {
      regenerateBaseline = true;
    } else if (argv[i]?.startsWith("--") && argv[i + 1]) {
      args[argv[i]!.slice(2)] = argv[i + 1]!;
      i++;
    }
  }

  return {
    scenariosDir: resolve(args["scenarios"] ?? DEFAULT_SCENARIOS_DIR),
    outputDir: resolve(args["output"] ?? DEFAULT_OUTPUT_DIR),
    baselineFile: resolve(args["baseline"] ?? DEFAULT_BASELINE),
    regenerateBaseline,
    subset: args["subset"],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Eval harness starting — scenarios: ${opts.scenariosDir}`);

  const runs = await runAllScenarios(opts.scenariosDir);

  // Load scenario definitions for scoring
  const { readdirSync } = await import("fs");
  const files = readdirSync(opts.scenariosDir).filter((f) => f.endsWith(".json")).sort();
  const scenarios = files.flatMap((f) => {
    try {
      const raw = JSON.parse(readFileSync(join(opts.scenariosDir, f), "utf-8")) as unknown;
      return [validateScenario(raw, f)];
    } catch {
      return [];
    }
  });

  const generatedAt = new Date().toISOString();
  const report = buildReport(runs, scenarios, generatedAt);

  // Write report.json
  mkdirSync(opts.outputDir, { recursive: true });
  const reportPath = join(opts.outputDir, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report written: ${reportPath}`);

  if (opts.regenerateBaseline) {
    // Explicit baseline regeneration — never runs automatically
    writeFileSync(opts.baselineFile, JSON.stringify(report, null, 2));
    console.log(`Baseline regenerated: ${opts.baselineFile}`);
    console.log("Review the baseline changes before merging.");
    process.exit(0);
    return;
  }

  // Load baseline and diff
  if (!existsSync(opts.baselineFile)) {
    console.error(`No baseline found at ${opts.baselineFile}. Run with --regenerate-baseline first.`);
    process.exit(1);
    return;
  }

  const baseline = JSON.parse(readFileSync(opts.baselineFile, "utf-8")) as Report;
  const diff = diffAgainstBaseline(report, baseline);
  const summary = formatSummary(report, diff);

  console.log(summary);

  if (!diff.pass) {
    console.error("\nGate FAILED. Failing dimensions:");
    for (const failure of diff.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
    return;
  }

  console.log("\nGate PASSED.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Eval harness error:", err);
  process.exit(1);
});
