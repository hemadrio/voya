/**
 * Thin compatibility shim — the canonical implementation is in src/domain/tools/.
 *
 * Re-exports ToolRegistry, ToolDispatcher, descriptor factories, and keeps
 * the legacy SEARCH_TOOLS / TOOL_BY_NAME / validateToolInput exports so
 * existing callers compile without change.  For new code, import from
 * src/domain/tools/ directly.
 */
import { z } from "zod";
import {
  FlightSearchRequestSchema,
  HotelSearchRequestSchema,
  CarRentalSearchRequestSchema,
  GetOfferInputSchema,
  GetUserPreferencesInputSchema,
} from "@travel/contracts";
import type { ZodTypeAny } from "zod";
import { ToolRegistry } from "./domain/tools/ToolRegistry.js";
import { createSearchFlightsDescriptor } from "./domain/tools/descriptors/search_flights.js";
import { createSearchHotelsDescriptor } from "./domain/tools/descriptors/search_hotels.js";
import { createSearchCarsDescriptor } from "./domain/tools/descriptors/search_cars.js";
import { createGetOfferDescriptor } from "./domain/tools/descriptors/get_offer.js";
import { createGetUserPreferencesDescriptor } from "./domain/tools/descriptors/get_user_preferences.js";

// Re-export canonical modules for new consumers.
export { ToolRegistry } from "./domain/tools/ToolRegistry.js";
export type { AnthropicTool, ToolRegistryConfig } from "./domain/tools/ToolRegistry.js";
export { ToolDispatcher } from "./domain/tools/ToolDispatcher.js";
export type { DispatchResult, ToolDispatcherDeps, ToolDispatcherConfig } from "./domain/tools/ToolDispatcher.js";
export type {
  ToolDescriptor, ToolContext, HttpClientPort, HttpResponse,
  TracerLike, SpanLike, ToolDispatchError, ToolDispatchErrorCode,
} from "./domain/tools/ToolDescriptor.js";
export { createSearchFlightsDescriptor } from "./domain/tools/descriptors/search_flights.js";
export { createSearchHotelsDescriptor } from "./domain/tools/descriptors/search_hotels.js";
export { createSearchCarsDescriptor } from "./domain/tools/descriptors/search_cars.js";
export { createGetOfferDescriptor } from "./domain/tools/descriptors/get_offer.js";
export { createGetUserPreferencesDescriptor } from "./domain/tools/descriptors/get_user_preferences.js";

// ---------------------------------------------------------------------------
// Factory for the default full registry (all 5 tools).
// ---------------------------------------------------------------------------

export function createDefaultRegistry(gatewayBaseUrl: string): ToolRegistry {
  return new ToolRegistry(
    [
      createSearchFlightsDescriptor(gatewayBaseUrl),
      createSearchHotelsDescriptor(gatewayBaseUrl),
      createSearchCarsDescriptor(gatewayBaseUrl),
      createGetOfferDescriptor(gatewayBaseUrl),
      createGetUserPreferencesDescriptor(gatewayBaseUrl),
    ],
    { gatewayBaseUrl },
  );
}

// ---------------------------------------------------------------------------
// Legacy exports — kept for backward compatibility with existing call sites.
// ---------------------------------------------------------------------------

/** Anthropic-compatible tool shape with a back-reference to the Zod schema. */
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Back-reference to the originating Zod schema — used by AC8 test. */
  _contractsSchema: ZodTypeAny;
}

/** Zod schemas parallel to each legacy tool — used by validateToolInput. */
const LEGACY_SCHEMAS: Record<string, ZodTypeAny> = {
  search_flights: FlightSearchRequestSchema,
  search_hotels: HotelSearchRequestSchema,
  search_cars: CarRentalSearchRequestSchema,
  get_offer: GetOfferInputSchema,
  get_user_preferences: GetUserPreferencesInputSchema,
};

const FALLBACK_GATEWAY = "http://localhost:8080";

const _legacyRegistry = createDefaultRegistry(FALLBACK_GATEWAY);

/** @deprecated Use ToolRegistry.list() for the full 5-tool registry. */
export const SEARCH_TOOLS: readonly ClaudeTool[] = _legacyRegistry.list().slice(0, 3).map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
  _contractsSchema: LEGACY_SCHEMAS[t.name] ?? z.unknown(),
}));

/** @deprecated Use ToolRegistry.get() instead. */
export const TOOL_BY_NAME: ReadonlyMap<string, ClaudeTool> = new Map(
  SEARCH_TOOLS.map((t) => [t.name, t]),
);

/**
 * @deprecated Use ToolDispatcher.dispatch() for full SSRF-safe validated dispatch.
 *
 * Validates model-emitted tool_use input against the originating contract schema.
 * Returns success with the typed input or failure with a ZodError.
 */
export function validateToolInput(
  toolName: string,
  rawInput: unknown,
): { success: true; data: unknown } | { success: false; error: z.ZodError } {
  const schema = LEGACY_SCHEMAS[toolName];
  if (schema === undefined) {
    return {
      success: false,
      error: new z.ZodError([
        { code: z.ZodIssueCode.custom, path: ["toolName"], message: `Unknown tool: ${toolName}` },
      ]),
    };
  }
  const result = schema.safeParse(rawInput);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, data: result.data };
}
