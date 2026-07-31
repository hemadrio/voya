/**
 * Baseline generator script.
 *
 * Converts every schema in SCHEMA_REGISTRY to a deterministic JSON Schema
 * document and writes it to contract-baselines/{schemaId}.json.
 *
 * Run after any schema change to regenerate the committed baselines:
 *   pnpm --filter @travel/contracts generate:baselines
 *
 * Then review the diff and commit alongside the schema edit.  A breaking
 * change (removed field, narrowed enum, etc.) requires a major version bump
 * in package.json in the same commit — see docs/contracts-versioning.md.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_REGISTRY, SCHEMA_IDS } from "../src/registry.js";
import { zodToJsonSchema } from "./zod-to-json-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASELINES_DIR = join(__dirname, "../contract-baselines");

mkdirSync(BASELINES_DIR, { recursive: true });

let written = 0;
for (const id of SCHEMA_IDS) {
  const schema = SCHEMA_REGISTRY[id];
  if (!schema) {
    console.error(`[generate-baselines] No schema for id: ${id}`);
    process.exit(1);
  }
  const jsonSchema = zodToJsonSchema(schema, id);
  const outPath = join(BASELINES_DIR, `${id}.json`);
  writeFileSync(outPath, JSON.stringify(jsonSchema, null, 2) + "\n", "utf8");
  written++;
}

console.log(`[generate-baselines] Wrote ${written} baseline files to ${BASELINES_DIR}`);
