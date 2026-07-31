/**
 * Baseline comparator test.
 *
 * For every schema in SCHEMA_REGISTRY, regenerates the JSON Schema in memory
 * and compares it to the committed baseline file.  A diff fails the test with
 * the schema identifier and a diff summary, instructing the author to review
 * the change and re-run the generator.
 *
 * This test is marked non-cacheable in turbo.json so a schema change always
 * re-runs the comparison even when the Turborepo remote cache would otherwise
 * serve a stale result.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "./test-helpers.js";
import { SCHEMA_REGISTRY, SCHEMA_IDS } from "../../src/registry.js";
import { zodToJsonSchema } from "../../scripts/zod-to-json-schema.js";

const BASELINES_DIR = join(process.cwd(), "contract-baselines");

describe("baseline comparator", () => {
  beforeAll(() => {
    if (!existsSync(BASELINES_DIR)) {
      throw new Error(
        `contract-baselines/ directory not found at ${BASELINES_DIR}. ` +
          "Run `pnpm --filter @travel/contracts generate:baselines` first.",
      );
    }
  });

  for (const id of SCHEMA_IDS) {
    it(`schema ${id} matches committed baseline`, () => {
      const baselinePath = join(BASELINES_DIR, `${id}.json`);
      if (!existsSync(baselinePath)) {
        throw new Error(
          `No baseline file for schema "${id}" at ${baselinePath}.\n` +
            "Run `pnpm --filter @travel/contracts generate:baselines` to create it, " +
            "review the diff, then commit the new file.",
        );
      }

      const committed = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
      const schema = SCHEMA_REGISTRY[id];
      if (!schema) throw new Error(`Schema not found in registry: ${id}`);
      const generated = zodToJsonSchema(schema, id);

      const committedStr = JSON.stringify(committed, null, 2);
      const generatedStr = JSON.stringify(generated, null, 2);

      if (committedStr !== generatedStr) {
        throw new Error(
          `Baseline mismatch for schema "${id}".\n` +
            "The generated JSON Schema differs from the committed baseline.\n" +
            "If this change is intentional, run:\n" +
            "  pnpm --filter @travel/contracts generate:baselines\n" +
            "then review the diff and commit the updated baseline alongside the schema change.\n" +
            "A breaking change requires a major-version bump in package.json — " +
            "see docs/contracts-versioning.md.\n\n" +
            `Committed:\n${committedStr}\n\nGenerated:\n${generatedStr}`,
        );
      }

      expect(generated).toEqual(committed);
    });
  }
});
