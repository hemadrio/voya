#!/usr/bin/env tsx
/**
 * Schema compatibility check — CI gate.
 *
 * Reads the current @travel/contracts schemas from SCHEMA_REGISTRY, generates
 * a JSON Schema for each, and diffs it against the committed baseline in
 * contract-baselines/. Classifies each change as additive or breaking using
 * the classifier from test/compatibility/classifier.ts.
 *
 * Exit codes:
 *   0 — all schemas are compatible (no-op or additive changes only)
 *   1 — breaking change detected without a major-version bump, or an error
 *       such as a missing baseline
 *
 * Usage:
 *   pnpm --filter @travel/contracts contracts:compat
 *   # or directly:
 *   tsx packages/contracts/scripts/check-schema-compatibility.ts
 *
 * AC8: Fails the build when a breaking change (removed field, narrowed type,
 *      new required field) is made without a major version bump. Never fails
 *      open: an absent or unreadable baseline is treated as a failure with an
 *      explicit message.
 * AC12 (proof): Output names the schema, the field, and the incompatibility.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_REGISTRY, SCHEMA_IDS } from "../src/registry.js";
import { zodToJsonSchema } from "./zod-to-json-schema.js";
import { classify } from "../test/compatibility/classifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_DIR = join(__dirname, "..");
const BASELINES_DIR = join(PACKAGE_DIR, "contract-baselines");
const PKG_JSON_PATH = join(PACKAGE_DIR, "package.json");

// ---------------------------------------------------------------------------
// Version bump detection
// ---------------------------------------------------------------------------

function readCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8")) as { version: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Compatibility check
// ---------------------------------------------------------------------------

interface Violation {
  schemaId: string;
  field: string;
  kind: "breaking" | "additive";
  reason: string;
}

function run(): void {
  const version = readCurrentVersion();
  const majorVersion = parseInt(version.split(".")[0] ?? "0", 10);

  console.log(`\n@travel/contracts schema compatibility check (v${version})\n`);
  console.log(`Baselines dir: ${BASELINES_DIR}`);
  console.log(`Schema count: ${SCHEMA_IDS.length}\n`);

  if (!existsSync(BASELINES_DIR)) {
    console.error(
      `ERROR: contract-baselines/ directory not found at ${BASELINES_DIR}.\n` +
        "This is the first run — run:\n" +
        "  pnpm --filter @travel/contracts generate:baselines\n" +
        "to create the initial baselines, then commit them.\n",
    );
    process.exit(1);
  }

  const violations: Violation[] = [];
  const warnings: string[] = [];
  let checked = 0;

  for (const id of SCHEMA_IDS) {
    const schema = SCHEMA_REGISTRY[id];
    if (!schema) {
      console.error(`ERROR: Schema "${id}" in SCHEMA_IDS but not found in SCHEMA_REGISTRY.`);
      process.exit(1);
    }

    const baselinePath = join(BASELINES_DIR, `${id}.json`);
    if (!existsSync(baselinePath)) {
      // Never fail open — a missing baseline is an error
      console.error(
        `ERROR: No committed baseline for schema "${id}" at ${baselinePath}.\n` +
          "Run generate:baselines and commit the new file before merging.\n" +
          "An absent baseline could mask a breaking change.\n",
      );
      process.exit(1);
    }

    let baseline: Record<string, unknown>;
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      console.error(
        `ERROR: Could not parse baseline file for "${id}" at ${baselinePath}: ${String(err)}\n`,
      );
      process.exit(1);
    }

    const current = zodToJsonSchema(schema, id);

    // Determine schema kind for the classifier
    const schemaKind: "request" | "response" | "other" =
      id.endsWith("Request") ? "request"
        : id.endsWith("Response") || id.endsWith("Event") ? "response"
        : "other";

    const result = classify(baseline, current, "", schemaKind);

    if (result.classification === "breaking") {
      for (const change of result.changes) {
        if (change.kind === "breaking") {
          violations.push({
            schemaId: id,
            field: change.path || "(root)",
            kind: "breaking",
            reason: change.reason,
          });
        }
      }
    } else if (result.classification === "additive") {
      for (const change of result.changes) {
        warnings.push(`  ${id} — ADDITIVE — ${change.path || "(root)"}: ${change.reason}`);
      }
    }

    checked++;
  }

  // Print results
  if (warnings.length > 0) {
    console.log("Additive changes (no action required):");
    for (const w of warnings) console.log(w);
    console.log();
  }

  if (violations.length === 0) {
    console.log(`✓ ${checked} schemas checked — no breaking changes.\n`);
    process.exit(0);
  }

  // Breaking changes detected
  console.error(`\n✗ Breaking schema changes detected (${violations.length} violation(s)):\n`);
  for (const v of violations) {
    console.error(`  Schema:  ${v.schemaId}`);
    console.error(`  Field:   ${v.field}`);
    console.error(`  Change:  ${v.reason}`);
    console.error();
  }

  // Check if major version was bumped
  if (majorVersion > 0) {
    // Heuristic: if major > the previous baseline major, it was bumped.
    // A more robust check would compare against the git tag; for CI we
    // require the author to also regenerate baselines after bumping, which
    // the comparator.test.ts will catch.
    const baselineVersion = readBaselineVersion();
    const baselineMajor = parseInt(baselineVersion.split(".")[0] ?? "0", 10);
    if (majorVersion > baselineMajor) {
      console.log(
        `Major version bumped from ${baselineVersion} to ${version} — breaking changes are permitted.\n` +
          "Ensure generate:baselines has been run to update the committed baselines.\n",
      );
      process.exit(0);
    }
  }

  console.error(
    `FATAL: Breaking schema changes without a major-version bump (current: v${version}).\n` +
      "Options:\n" +
      "  1. Revert the breaking change and use an expand-and-contract migration.\n" +
      "  2. Bump the major version in packages/contracts/package.json AND\n" +
      "     run `pnpm --filter @travel/contracts generate:baselines` to update baselines.\n" +
      "See docs/contracts-versioning.md for guidance.\n",
  );
  process.exit(1);
}

function readBaselineVersion(): string {
  // The phase0-metrics.json records the version at the time baselines were generated
  const metricsPath = join(BASELINES_DIR, "phase0-metrics.json");
  if (existsSync(metricsPath)) {
    try {
      const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as { contractsVersion?: string };
      return metrics.contractsVersion ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  }
  return "0.0.0";
}

run();
