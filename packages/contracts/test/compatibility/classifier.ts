/**
 * Additive-versus-breaking schema change classifier.
 *
 * Accepts two JSON Schema objects (before and after) and returns a
 * classification plus a list of individual changes.  The classification
 * drives the version-gate check: a breaking change requires the contracts
 * package major version to have been incremented in the same commit.
 *
 * Classification rules (documented in docs/contracts-versioning.md):
 *   additive  — new optional property, added enum member on a response schema
 *   breaking  — removed property, property newly required, type change,
 *               removed enum member, or added enum member on a request schema
 *   no-op     — no structural changes
 */

export type ChangeKind = "additive" | "breaking";
export type Classification = "additive" | "breaking" | "no-op";

export interface CompatibilityChange {
  kind: ChangeKind;
  reason: string;
  path: string;
}

export interface ClassificationResult {
  classification: Classification;
  changes: CompatibilityChange[];
}

type JsonSchema = Record<string, unknown>;

export function classify(
  before: JsonSchema,
  after: JsonSchema,
  path: string = "",
  schemaKind: "request" | "response" | "other" = "other",
): ClassificationResult {
  const changes: CompatibilityChange[] = [];

  // Type change
  if (before["type"] !== after["type"] && (before["type"] !== undefined || after["type"] !== undefined)) {
    changes.push({ kind: "breaking", reason: "type changed", path });
    return { classification: "breaking", changes };
  }

  // Enum changes
  if (before["enum"] !== undefined || after["enum"] !== undefined) {
    const beforeEnum = (before["enum"] as unknown[]) ?? [];
    const afterEnum = (after["enum"] as unknown[]) ?? [];
    const beforeSet = new Set(beforeEnum);
    const afterSet = new Set(afterEnum);
    for (const v of beforeEnum) {
      if (!afterSet.has(v)) {
        changes.push({ kind: "breaking", reason: `enum value removed: ${String(v)}`, path });
      }
    }
    for (const v of afterEnum) {
      if (!beforeSet.has(v)) {
        const kind: ChangeKind =
          schemaKind === "response" || schemaKind === "other" ? "additive" : "breaking";
        changes.push({ kind, reason: `enum value added: ${String(v)}`, path });
      }
    }
    return aggregate(changes);
  }

  // oneOf / allOf array comparison
  if (before["oneOf"] !== undefined || after["oneOf"] !== undefined) {
    const bArr = (before["oneOf"] as JsonSchema[]) ?? [];
    const aArr = (after["oneOf"] as JsonSchema[]) ?? [];
    if (bArr.length !== aArr.length) {
      changes.push({ kind: "breaking", reason: "oneOf branch count changed", path });
    }
    const len = Math.min(bArr.length, aArr.length);
    for (let i = 0; i < len; i++) {
      const sub = bArr[i] !== undefined && aArr[i] !== undefined
        ? classify(bArr[i] as JsonSchema, aArr[i] as JsonSchema, `${path}/oneOf/${i}`, schemaKind)
        : { changes: [] as CompatibilityChange[] };
      changes.push(...sub.changes);
    }
    return aggregate(changes);
  }

  // Object schema
  if (before["properties"] !== undefined || after["properties"] !== undefined) {
    const beforeProps = (before["properties"] as Record<string, JsonSchema>) ?? {};
    const afterProps = (after["properties"] as Record<string, JsonSchema>) ?? {};
    const beforeRequired = new Set((before["required"] as string[]) ?? []);
    const afterRequired = new Set((after["required"] as string[]) ?? []);

    // Removed properties
    for (const key of Object.keys(beforeProps)) {
      if (afterProps[key] === undefined) {
        changes.push({ kind: "breaking", reason: `property removed: ${key}`, path: `${path}/properties/${key}` });
      } else {
        const sub = classify(
          beforeProps[key] as JsonSchema,
          afterProps[key] as JsonSchema,
          `${path}/properties/${key}`,
          schemaKind,
        );
        changes.push(...sub.changes);
      }
    }

    // Added properties
    for (const key of Object.keys(afterProps)) {
      if (beforeProps[key] === undefined) {
        const isRequired = afterRequired.has(key);
        changes.push({
          kind: isRequired ? "breaking" : "additive",
          reason: isRequired ? `required property added: ${key}` : `optional property added: ${key}`,
          path: `${path}/properties/${key}`,
        });
      }
    }

    // Existing property newly required
    for (const key of Object.keys(beforeProps)) {
      if (afterProps[key] !== undefined && !beforeRequired.has(key) && afterRequired.has(key)) {
        changes.push({ kind: "breaking", reason: `property made required: ${key}`, path: `${path}/properties/${key}` });
      }
    }

    // Existing property made optional (additive)
    for (const key of Object.keys(beforeProps)) {
      if (afterProps[key] !== undefined && beforeRequired.has(key) && !afterRequired.has(key)) {
        changes.push({ kind: "additive", reason: `property made optional: ${key}`, path: `${path}/properties/${key}` });
      }
    }

    // additionalProperties change
    if (before["additionalProperties"] !== after["additionalProperties"]) {
      changes.push({ kind: "breaking", reason: "additionalProperties changed", path });
    }

    return aggregate(changes);
  }

  // Array schema — recurse into items
  if (before["items"] !== undefined && after["items"] !== undefined) {
    const sub = classify(
      before["items"] as JsonSchema,
      after["items"] as JsonSchema,
      `${path}/items`,
      schemaKind,
    );
    changes.push(...sub.changes);
    if (before["minItems"] !== after["minItems"]) {
      changes.push({ kind: "breaking", reason: "minItems changed", path });
    }
    return aggregate(changes);
  }

  return { classification: "no-op", changes: [] };
}

function aggregate(changes: CompatibilityChange[]): ClassificationResult {
  if (changes.some((c) => c.kind === "breaking")) return { classification: "breaking", changes };
  if (changes.length > 0) return { classification: "additive", changes };
  return { classification: "no-op", changes };
}

export function versionGate(
  before: JsonSchema,
  after: JsonSchema,
  beforeVersion: string,
  afterVersion: string,
  schemaKind: "request" | "response" | "other" = "other",
): { passed: boolean; reason?: string; classification: Classification } {
  const result = classify(before, after, "", schemaKind);
  if (result.classification !== "breaking") return { passed: true, classification: result.classification };
  const beforeMajor = parseInt(beforeVersion.split(".")[0] ?? "0", 10);
  const afterMajor = parseInt(afterVersion.split(".")[0] ?? "0", 10);
  if (afterMajor > beforeMajor) return { passed: true, classification: result.classification };
  return {
    passed: false,
    reason: `Breaking change detected without major-version bump (${beforeVersion} → ${afterVersion}). ` +
      `See docs/contracts-versioning.md for the expand-and-contract rule.`,
    classification: result.classification,
  };
}
