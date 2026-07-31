import type { ZodTypeAny } from "zod";

export type JsonSchemaObject = Record<string, unknown>;

/**
 * Converts a Zod schema to a JSON Schema 2020-12 / OpenAPI 3.1 compatible
 * object.  Handles the subset of Zod types used in @travel/contracts.
 *
 * Complex Zod pipelines (transform + pipe) use the output-side schema as
 * the OpenAPI representation because that schema carries the format
 * constraints (e.g. the IATA airport-code pattern after the pipe).
 *
 * ZodEffects (superRefine / transform) unwrap to their inner schema because
 * the refinement logic is a runtime check that has no JSON Schema analogue.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchemaObject {
  const def = (schema as unknown as { _def: ZodDef })._def;
  return convertDef(def);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ZodDef {
  typeName: string;
  // ZodString / ZodNumber checks
  checks?: Array<{ kind: string; value?: unknown; regex?: RegExp; inclusive?: boolean; message?: string }>;
  // ZodObject
  shape?: () => Record<string, ZodTypeAny>;
  unknownKeys?: string;
  // ZodArray
  type?: ZodTypeAny;
  // ZodEnum / ZodNativeEnum
  values?: string[] | Record<string, unknown>;
  // ZodLiteral
  value?: unknown;
  // ZodRecord
  valueType?: ZodTypeAny;
  // ZodOptional / ZodNullable / ZodDefault / ZodCatch / ZodBranded
  innerType?: ZodTypeAny;
  // ZodEffects
  schema?: ZodTypeAny;
  // ZodPipeline
  in?: ZodTypeAny;
  out?: ZodTypeAny;
  // ZodUnion
  options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
  // ZodIntersection
  left?: ZodTypeAny;
  right?: ZodTypeAny;
  // ZodDiscriminatedUnion
  discriminator?: string;
  // ZodDefault
  defaultValue?: () => unknown;
  // ZodBranded inner
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function convertDef(def: ZodDef): JsonSchemaObject {
  switch (def.typeName) {
    case "ZodString":
      return buildStringSchema(def);
    case "ZodNumber":
      return buildNumberSchema(def);
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNull":
      return { type: "null" };
    case "ZodDate":
      return { type: "string", format: "date-time" };
    case "ZodEnum":
      return { type: "string", enum: def.values as string[] };
    case "ZodNativeEnum":
      return { type: "string", enum: Object.values(def.values as Record<string, unknown>) as string[] };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type as ZodTypeAny) };
    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: zodToJsonSchema(def.valueType as ZodTypeAny),
      };
    case "ZodObject":
      return buildObjectSchema(def);
    case "ZodOptional":
      return zodToJsonSchema(def.innerType as ZodTypeAny);
    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny);
      return { oneOf: [inner, { type: "null" }] };
    }
    case "ZodUnion": {
      const opts = def.options;
      if (Array.isArray(opts)) {
        return { oneOf: opts.map(zodToJsonSchema) };
      }
      return { oneOf: Array.from((opts as Map<unknown, ZodTypeAny>).values()).map(zodToJsonSchema) };
    }
    case "ZodDiscriminatedUnion": {
      const opts = def.options as Map<unknown, ZodTypeAny> | ZodTypeAny[];
      const schemas = Array.isArray(opts)
        ? opts.map(zodToJsonSchema)
        : Array.from(opts.values()).map(zodToJsonSchema);
      const result: JsonSchemaObject = { oneOf: schemas };
      if (def.discriminator) result.discriminator = { propertyName: def.discriminator };
      return result;
    }
    case "ZodIntersection":
      return {
        allOf: [
          zodToJsonSchema(def.left as ZodTypeAny),
          zodToJsonSchema(def.right as ZodTypeAny),
        ],
      };
    case "ZodEffects":
      return zodToJsonSchema(def.schema as ZodTypeAny);
    case "ZodPipeline":
      // Use the output schema — it carries the format/pattern constraints
      return zodToJsonSchema(def.out as ZodTypeAny);
    case "ZodBranded":
      return zodToJsonSchema(def.type as ZodTypeAny);
    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny);
      const defaultVal = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      return { ...inner, default: defaultVal };
    }
    case "ZodCatch":
      return zodToJsonSchema(def.innerType as ZodTypeAny);
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStringSchema(def: ZodDef): JsonSchemaObject {
  const result: JsonSchemaObject = { type: "string" };
  if (!def.checks) return result;
  for (const check of def.checks) {
    switch (check.kind) {
      case "min":
        result.minLength = check.value;
        break;
      case "max":
        result.maxLength = check.value;
        break;
      case "regex":
        result.pattern = (check.regex as RegExp).source;
        break;
      case "email":
        result.format = "email";
        break;
      case "uuid":
        result.format = "uuid";
        break;
      case "datetime":
        result.format = "date-time";
        break;
      case "url":
        result.format = "uri";
        break;
      case "length":
        result.minLength = check.value;
        result.maxLength = check.value;
        break;
    }
  }
  return result;
}

function buildNumberSchema(def: ZodDef): JsonSchemaObject {
  const result: JsonSchemaObject = { type: "number" };
  if (!def.checks) return result;
  for (const check of def.checks) {
    switch (check.kind) {
      case "min":
        if (check.inclusive) result.minimum = check.value;
        else result.exclusiveMinimum = check.value;
        break;
      case "max":
        if (check.inclusive) result.maximum = check.value;
        else result.exclusiveMaximum = check.value;
        break;
      case "int":
        result.type = "integer";
        break;
      case "multipleOf":
        result.multipleOf = check.value;
        break;
    }
  }
  return result;
}

function buildObjectSchema(def: ZodDef): JsonSchemaObject {
  const shape = def.shape!();
  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const fieldDef = (fieldSchema as unknown as { _def: ZodDef })._def;
    properties[key] = zodToJsonSchema(fieldSchema);
    const isOptional =
      fieldDef.typeName === "ZodOptional" || fieldDef.typeName === "ZodDefault";
    if (!isOptional) required.push(key);
  }

  const result: JsonSchemaObject = { type: "object", properties: sortKeys(properties) };
  if (required.length > 0) result.required = required.sort();
  if (def.unknownKeys === "strict") result.additionalProperties = false;
  return result;
}

function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = (obj as Record<string, unknown>)[key];
      return acc;
    }, {} as Record<string, unknown>) as T;
}
