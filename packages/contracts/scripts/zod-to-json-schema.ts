/**
 * Lightweight Zod v3 → JSON Schema converter for the contract compatibility
 * harness.  Handles the subset of Zod types used in @travel/contracts; the
 * goal is a deterministic structural fingerprint, not a perfect JSON Schema
 * validator.
 *
 * Transforms, superRefine rules, and pipeline output types are intentionally
 * ignored — only the static wire shape matters for baseline comparison.
 * Cross-field rules (date-order, ILLUSTRATIVE-not-bookable) are covered by
 * separate behavioural tests.
 */
import type { ZodTypeAny } from "zod";

export type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodTypeAny, schemaId?: string): JsonSchema {
  const inner = extractSchema(schema);
  const doc: JsonSchema = schemaId
    ? { $schema: "https://json-schema.org/draft/2020-12/schema", schemaId, ...inner }
    : inner;
  return sortDeep(doc) as JsonSchema;
}

function extractSchema(schema: ZodTypeAny): JsonSchema {
  const def = (schema as unknown as Record<string, unknown>)._def as Record<string, unknown>;
  const typeName = def.typeName as string;

  switch (typeName) {
    case "ZodEffects":
      return extractSchema(def.schema as ZodTypeAny);

    case "ZodPipeline":
      return extractSchema(def.in as ZodTypeAny);

    case "ZodOptional":
    case "ZodDefault":
      return extractSchema(def.innerType as ZodTypeAny);

    case "ZodNullable":
      return { oneOf: [extractSchema(def.innerType as ZodTypeAny), { type: "null" }] };

    case "ZodString":
      return extractStringSchema(def);

    case "ZodNumber":
      return extractNumberSchema(def);

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodLiteral":
      return { const: def.value };

    case "ZodEnum": {
      const values = [...(def.values as string[])].sort();
      return { enum: values, type: "string" };
    }

    case "ZodObject":
      return extractObjectSchema(def);

    case "ZodArray": {
      const result: JsonSchema = {
        items: extractSchema(def.type as ZodTypeAny),
        type: "array",
      };
      if ((def.minLength as { value?: number } | undefined)?.value !== undefined) {
        result["minItems"] = (def.minLength as { value: number }).value;
      }
      if ((def.maxLength as { value?: number } | undefined)?.value !== undefined) {
        result["maxItems"] = (def.maxLength as { value: number }).value;
      }
      return result;
    }

    case "ZodRecord":
      return {
        additionalProperties: def.valueType
          ? extractSchema(def.valueType as ZodTypeAny)
          : {},
        type: "object",
      };

    case "ZodUnion":
      return { oneOf: (def.options as ZodTypeAny[]).map(extractSchema) };

    case "ZodIntersection":
      return { allOf: [extractSchema(def.left as ZodTypeAny), extractSchema(def.right as ZodTypeAny)] };

    case "ZodAny":
    case "ZodUnknown":
      return {};

    default:
      return { "x-zodType": typeName };
  }
}

function extractStringSchema(def: Record<string, unknown>): JsonSchema {
  const result: JsonSchema = { type: "string" };
  for (const check of (def.checks ?? []) as Array<Record<string, unknown>>) {
    const kind = check["kind"] as string;
    if (kind === "min") result["minLength"] = check["value"] as number;
    if (kind === "max") result["maxLength"] = check["value"] as number;
    if (kind === "email") result["format"] = "email";
    if (kind === "datetime") result["format"] = "date-time";
    if (kind === "url") result["format"] = "uri";
    if (kind === "uuid") result["format"] = "uuid";
    if (kind === "regex") result["pattern"] = (check["regex"] as RegExp).source;
  }
  return result;
}

function extractNumberSchema(def: Record<string, unknown>): JsonSchema {
  let isInt = false;
  let minimum: number | undefined;
  let maximum: number | undefined;
  for (const check of (def.checks ?? []) as Array<Record<string, unknown>>) {
    const kind = check["kind"] as string;
    if (kind === "int") isInt = true;
    if (kind === "min" && check["value"] !== undefined) minimum = check["value"] as number;
    if (kind === "max" && check["value"] !== undefined) maximum = check["value"] as number;
  }
  const result: JsonSchema = { type: isInt ? "integer" : "number" };
  if (minimum !== undefined) result["minimum"] = minimum;
  if (maximum !== undefined) result["maximum"] = maximum;
  return result;
}

function extractObjectSchema(def: Record<string, unknown>): JsonSchema {
  const shapeFn = def.shape as () => Record<string, ZodTypeAny>;
  const shape = shapeFn();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const fieldDef = (fieldSchema as unknown as Record<string, unknown>)._def as Record<string, unknown>;
    const isOptional =
      fieldDef["typeName"] === "ZodOptional" || fieldDef["typeName"] === "ZodDefault";
    properties[key] = extractSchema(fieldSchema);
    if (!isOptional) required.push(key);
  }

  const result: JsonSchema = { properties, type: "object" };
  if (required.length > 0) result["required"] = required.sort();
  if (def.unknownKeys !== "passthrough") result["additionalProperties"] = false;
  return result;
}

function sortDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortDeep);
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(val).sort()) {
      out[key] = sortDeep((val as Record<string, unknown>)[key]);
    }
    return out;
  }
  return val;
}
