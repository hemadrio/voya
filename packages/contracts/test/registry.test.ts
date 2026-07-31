/**
 * Registry completeness test.
 *
 * 1. Every schema ID in SCHEMA_REGISTRY has a committed baseline file.
 * 2. Every committed baseline file corresponds to a registered schema ID.
 *
 * A new schema added to the package but not to the registry fails assertion 1
 * indirectly: the registry completeness check is the human gate, not an
 * automated scan of src/ exports (which would require complex static analysis).
 * The pragmatic guard is: the generator script will fail the CI comparator
 * test the next run because the baseline file won't exist.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_IDS } from "../src/registry.js";

const BASELINES_DIR = join(process.cwd(), "contract-baselines");

describe("registry completeness", () => {
  it("has the expected number of registered schema IDs", () => {
    expect(SCHEMA_IDS.length).toBe(23);
  });

  it("every registered schema ID has a committed baseline file", () => {
    const missing: string[] = [];
    for (const id of SCHEMA_IDS) {
      const filePath = join(BASELINES_DIR, `${id}.json`);
      if (!existsSync(filePath)) missing.push(id);
    }
    if (missing.length > 0) {
      throw new Error(
        `Missing baseline files for: ${missing.join(", ")}.\n` +
          "Run `pnpm --filter @travel/contracts generate:baselines` to create them.",
      );
    }
  });

  it("every committed baseline file corresponds to a registered schema ID", () => {
    if (!existsSync(BASELINES_DIR)) return;
    const files = readdirSync(BASELINES_DIR)
      .filter((f) => f.endsWith(".json") && f !== "phase0-metrics.json")
      .map((f) => f.replace(/\.json$/, ""));
    const registeredSet = new Set(SCHEMA_IDS);
    const stale = files.filter((id) => !registeredSet.has(id));
    if (stale.length > 0) {
      throw new Error(
        `Stale baseline files with no registered schema: ${stale.join(", ")}.\n` +
          "Remove them or add the schema to SCHEMA_REGISTRY in src/registry.ts.",
      );
    }
  });
});
