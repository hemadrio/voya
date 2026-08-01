/**
 * ToolRegistry — closed, statically declared set of first-party tools.
 *
 * list()   → Anthropic-compatible tool definitions (name, description, input_schema).
 * get(name) → exact-match lookup after normalisation (trim + reject on case mismatch).
 *
 * No dynamic registration — tool set is compile-time declared.
 * No framework imports — this module is pure domain logic.
 */
import type { ZodTypeAny } from "zod";
import type { ToolDescriptor } from "./ToolDescriptor.js";

// ---------------------------------------------------------------------------
// Minimal zodToJsonSchema — covers ZodObject, ZodString, ZodNumber, ZodEnum,
// ZodOptional, ZodDefault, ZodEffects, ZodPipeline, ZodLiteral, ZodArray,
// ZodUnion, ZodNullable, ZodBoolean.
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: ZodTypeAny, depth = 0): JsonSchema {
  if (depth > 10) return {};
  const def = schema._def as Record<string, unknown>;
  const typeName = def.typeName as string;

  switch (typeName) {
    case "ZodString": {
      const r: JsonSchema = { type: "string" };
      if (typeof def.description === "string") r.description = def.description;
      return r;
    }
    case "ZodNumber": {
      const r: JsonSchema = { type: "number" };
      if (Array.isArray(def.checks)) {
        for (const c of def.checks as Array<{ kind: string; value?: number }>) {
          if (c.kind === "int") r.type = "integer";
          if (c.kind === "min" && c.value !== undefined) r.minimum = c.value;
          if (c.kind === "max" && c.value !== undefined) r.maximum = c.value;
        }
      }
      return r;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodOptional":
      return zodToJsonSchema(def.innerType as ZodTypeAny, depth + 1);
    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny, depth + 1);
      return { oneOf: [inner, { type: "null" }] };
    }
    case "ZodDefault":
      return { ...zodToJsonSchema(def.innerType as ZodTypeAny, depth + 1), default: (def.defaultValue as () => unknown)() };
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v, depth + 1);
        const vDef = (v as ZodTypeAny)._def as Record<string, unknown>;
        if (vDef.typeName !== "ZodOptional" && vDef.typeName !== "ZodDefault") {
          required.push(k);
        }
      }
      const r: JsonSchema = { type: "object", properties };
      if (required.length > 0) r.required = required;
      if (def.unknownKeys === "strict") r.additionalProperties = false;
      return r;
    }
    case "ZodEffects":
    case "ZodTransform": {
      const inner = (def.schema ?? def.innerType) as ZodTypeAny | undefined;
      return inner ? zodToJsonSchema(inner, depth + 1) : {};
    }
    case "ZodPipeline":
      return zodToJsonSchema(def.in as ZodTypeAny, depth + 1);
    case "ZodUnion":
      return { oneOf: (def.options as ZodTypeAny[]).map((o) => zodToJsonSchema(o, depth + 1)) };
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type as ZodTypeAny, depth + 1) };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Anthropic-compatible tool definition shape
// ---------------------------------------------------------------------------

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** Back-reference to the originating descriptor — for test introspection. */
  _descriptor: ToolDescriptor;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export interface ToolRegistryConfig {
  /** Full base URL of the internal API gateway (e.g. "http://api-gateway:8080"). */
  gatewayBaseUrl: string;
}

export class ToolRegistry {
  private readonly descriptors: ReadonlyMap<string, ToolDescriptor>;
  readonly config: ToolRegistryConfig;

  constructor(descriptors: ToolDescriptor[], config: ToolRegistryConfig) {
    this.config = config;
    const map = new Map<string, ToolDescriptor>();
    for (const d of descriptors) {
      if (map.has(d.name)) {
        throw new Error(`Duplicate tool name registered: "${d.name}"`);
      }
      map.set(d.name, d);
    }
    this.descriptors = map;
  }

  /**
   * Returns Anthropic-compatible tool definitions for all registered tools.
   * input_schema is generated from the Zod inputSchema so the model-facing
   * contract and runtime validator cannot drift.
   */
  list(): AnthropicTool[] {
    return Array.from(this.descriptors.values()).map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: zodToJsonSchema(d.inputSchema),
      _descriptor: d,
    }));
  }

  /**
   * Exact-match lookup after trimming.
   * Different casing or extra whitespace normalises to the trimmed form, then
   * is rejected if it doesn't match an exact registered name (AC edge case).
   */
  get(name: string): ToolDescriptor | undefined {
    const normalised = name.trim();
    return this.descriptors.get(normalised);
  }
}
