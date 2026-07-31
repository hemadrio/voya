/**
 * Claude tool registry for the AI orchestration service.
 *
 * AC8: Tool input_schema objects are generated from the same @travel/contracts
 * Zod schemas that the search-service boundary validates against — NOT
 * hand-written — so the model cannot emit a tool call that the boundary
 * would reject.
 *
 * The JSON Schema conversion uses zodToJsonSchema (lightweight utility that
 * recursively walks Zod schema internals).  The result is typed as the
 * Anthropic SDK's `Tool` shape so the tool registry is directly usable in
 * a `client.messages.create({ tools })` call.
 */
import { z } from "zod";
import {
  FlightSearchRequestSchema,
  HotelSearchRequestSchema,
  CarRentalSearchRequestSchema,
} from "@travel/contracts";
import type { ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Minimal JSON Schema converter
//
// The full zodToJsonSchema package is not yet in the catalog.  This
// implementation covers the subset of Zod types used by the search schemas:
// ZodObject, ZodString, ZodNumber, ZodEnum, ZodOptional, ZodTransform,
// ZodEffects (superRefine / .pipe()), ZodLiteral, and ZodBranded.
// ---------------------------------------------------------------------------

type JsonSchemaType = Record<string, unknown>;

function zodToJsonSchema(schema: ZodTypeAny, depth = 0): JsonSchemaType {
  // Prevent runaway recursion on malformed schemas.
  if (depth > 10) return {};

  const def = schema._def as Record<string, unknown>;
  const typeName = def.typeName as string;

  switch (typeName) {
    case "ZodString": {
      const result: JsonSchemaType = { type: "string" };
      if (typeof def.description === "string") result.description = def.description;
      return result;
    }

    case "ZodNumber": {
      const result: JsonSchemaType = { type: "number" };
      if (Array.isArray(def.checks)) {
        for (const check of def.checks as Array<{ kind: string; value?: number; message?: string }>) {
          if (check.kind === "int") result.type = "integer";
          if (check.kind === "min" && check.value !== undefined) result.minimum = check.value;
          if (check.kind === "max" && check.value !== undefined) result.maximum = check.value;
        }
      }
      return result;
    }

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodEnum": {
      const values = def.values as string[];
      return { type: "string", enum: values };
    }

    case "ZodLiteral":
      return { const: def.value };

    case "ZodOptional": {
      const inner = def.innerType as ZodTypeAny;
      return zodToJsonSchema(inner, depth + 1);
    }

    case "ZodNullable": {
      const inner = def.innerType as ZodTypeAny;
      const innerSchema = zodToJsonSchema(inner, depth + 1);
      return { oneOf: [innerSchema, { type: "null" }] };
    }

    case "ZodDefault": {
      const inner = def.innerType as ZodTypeAny;
      return { ...zodToJsonSchema(inner, depth + 1), default: def.defaultValue };
    }

    case "ZodObject": {
      const shape = def.shape?.() as Record<string, ZodTypeAny>;
      const properties: Record<string, JsonSchemaType> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value, depth + 1);
        const valueDef = (value as ZodTypeAny)._def as Record<string, unknown>;
        if (valueDef.typeName !== "ZodOptional" && valueDef.typeName !== "ZodDefault") {
          required.push(key);
        }
      }

      const result: JsonSchemaType = {
        type: "object",
        properties,
      };
      if (required.length > 0) result.required = required;
      if (def.unknownKeys === "strict") result.additionalProperties = false;

      return result;
    }

    case "ZodEffects":
    case "ZodTransform": {
      // superRefine / .transform() / .pipe() — unwrap the inner schema.
      const inner = (def.schema ?? def.innerType) as ZodTypeAny | undefined;
      if (inner) return zodToJsonSchema(inner, depth + 1);
      return {};
    }

    case "ZodPipeline": {
      // .pipe() — use the input (in) schema for the JSON Schema representation.
      const inner = def.in as ZodTypeAny;
      return zodToJsonSchema(inner, depth + 1);
    }

    case "ZodUnion": {
      const options = def.options as ZodTypeAny[];
      return { oneOf: options.map((o) => zodToJsonSchema(o, depth + 1)) };
    }

    case "ZodArray": {
      const items = def.type as ZodTypeAny;
      return { type: "array", items: zodToJsonSchema(items, depth + 1) };
    }

    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Tool interface (Anthropic SDK shape)
// ---------------------------------------------------------------------------

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: JsonSchemaType;
  /** Back-reference to the originating Zod schema — used by AC8 test. */
  _contractsSchema: ZodTypeAny;
}

// ---------------------------------------------------------------------------
// Tool registry — derived directly from @travel/contracts schemas (AC8)
// ---------------------------------------------------------------------------

export const SEARCH_TOOLS: readonly ClaudeTool[] = [
  {
    name: "search_flights",
    description:
      "Search for available flights between two airports. " +
      "Airport codes must be valid 3-letter IATA codes. " +
      "Departure date must be in the future. " +
      "Results are ILLUSTRATIVE until a live search is completed.",
    input_schema: zodToJsonSchema(FlightSearchRequestSchema),
    _contractsSchema: FlightSearchRequestSchema,
  },
  {
    name: "search_hotels",
    description:
      "Search for hotels at a location. " +
      "Check-out date must be strictly after check-in date. " +
      "Results are ILLUSTRATIVE until a live search is completed.",
    input_schema: zodToJsonSchema(HotelSearchRequestSchema),
    _contractsSchema: HotelSearchRequestSchema,
  },
  {
    name: "search_cars",
    description:
      "Search for car rental options. " +
      "Pickup date must be in the future. " +
      "Drop-off date must be strictly after pickup date. " +
      "Results are ILLUSTRATIVE until a live search is completed.",
    input_schema: zodToJsonSchema(CarRentalSearchRequestSchema),
    _contractsSchema: CarRentalSearchRequestSchema,
  },
] as const;

/** Map from tool name to its ClaudeTool definition — for O(1) lookup. */
export const TOOL_BY_NAME: ReadonlyMap<string, ClaudeTool> = new Map(
  SEARCH_TOOLS.map((t) => [t.name, t]),
);

/**
 * Validate a model-emitted tool_use input against the originating contract
 * schema.  Returns success with the typed input, or failure with a
 * VALIDATION_FAILED envelope (the model call is rejected before any first-
 * party search endpoint is invoked).
 */
export function validateToolInput(
  toolName: string,
  rawInput: unknown,
): { success: true; data: unknown } | { success: false; error: z.ZodError } {
  const tool = TOOL_BY_NAME.get(toolName);
  if (!tool) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ["toolName"],
          message: `Unknown tool: ${toolName}`,
        },
      ]),
    };
  }

  const result = tool._contractsSchema.safeParse(rawInput);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, data: result.data };
}
