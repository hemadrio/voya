/**
 * Control matrix loader and validator.
 *
 * Parses docs/compliance/control-matrix.yaml and validates it against
 * the expected schema. Fails fast (throws) if:
 *   - A control declares an evidence_source not in the registered adapter set.
 *   - The YAML fails structural validation (missing required fields).
 *   - A duplicate control id is found.
 *
 * AC7: schema drift is caught before any artefact is written.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
import type { ControlMatrix, ControlEntry } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default matrix path: relative from the compiled dist/ output up to the
 * repo root, then into docs/compliance/. Overridable via CONTROL_MATRIX_PATH
 * env var or direct argument (for tests).
 */
const DEFAULT_MATRIX_PATH = resolve(__dirname, "../../docs/compliance/control-matrix.yaml");

export function loadControlMatrix(matrixPath?: string): ControlMatrix {
  const path = matrixPath ?? process.env["CONTROL_MATRIX_PATH"] ?? DEFAULT_MATRIX_PATH;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read control matrix at ${path}: ${String(err)}`);
  }

  let raw: unknown;
  try {
    raw = yamlLoad(content);
  } catch (err) {
    throw new Error(`control-matrix.yaml YAML parse error: ${String(err)}`);
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("control-matrix.yaml: root must be an object");
  }

  const doc = raw as Record<string, unknown>;

  // Structural validation
  if (!doc["schema_version"]) throw new Error("control-matrix.yaml: missing schema_version");
  if (!Array.isArray(doc["controls"])) throw new Error("control-matrix.yaml: missing controls array");
  if (!Array.isArray(doc["control_groups"])) throw new Error("control-matrix.yaml: missing control_groups array");

  const controls = doc["controls"] as Array<Record<string, unknown>>;
  const REQUIRED_FIELDS = ["id", "group", "description", "evidence_source", "status"] as const;

  const ids = new Set<string>();
  for (const ctrl of controls) {
    for (const field of REQUIRED_FIELDS) {
      if (!ctrl[field]) {
        throw new Error(
          `control-matrix.yaml: control missing required field "${field}": ${JSON.stringify(ctrl)}`,
        );
      }
    }
    const id = ctrl["id"] as string;
    if (!/^[a-z][a-z0-9-]+$/.test(id)) {
      throw new Error(`control-matrix.yaml: control id "${id}" must be kebab-case`);
    }
    if (ids.has(id)) {
      throw new Error(`control-matrix.yaml: duplicate control id "${id}"`);
    }
    ids.add(id);
  }

  return {
    schema_version: doc["schema_version"] as string,
    control_groups: doc["control_groups"] as Array<{ id: string; name: string }>,
    controls: controls as unknown as ControlEntry[],
  };
}

/**
 * Validate that every non-planned control's evidence_source has a registered adapter.
 * Throws a descriptive error listing all missing adapters so drift is caught before
 * any artefact is written (AC7).
 */
export function validateAdapters(matrix: ControlMatrix, registeredNames: Set<string>): void {
  const missing: string[] = [];
  for (const ctrl of matrix.controls) {
    if (ctrl.status === "planned") continue;
    if (!registeredNames.has(ctrl.evidence_source)) {
      missing.push(`${ctrl.id} → evidence_source="${ctrl.evidence_source}" has no registered adapter`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Control matrix adapter drift detected:\n${missing.map((m) => `  - ${m}`).join("\n")}\n` +
        `Register an adapter or mark the control status: planned`,
    );
  }
}
