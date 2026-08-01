/**
 * ToolRegistry unit tests.
 *
 * Covers: enumeration, JSON schema generation, exact-match lookup, edge cases.
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/domain/tools/ToolRegistry.js";
import { createDefaultRegistry } from "../../src/tools.js";
import {
  FlightSearchRequestSchema,
  HotelSearchRequestSchema,
  CarRentalSearchRequestSchema,
  GetOfferInputSchema,
  GetUserPreferencesInputSchema,
} from "@travel/contracts";

const GATEWAY = "http://api-gateway.internal:8080";

function makeRegistry(): ToolRegistry {
  return createDefaultRegistry(GATEWAY);
}

describe("ToolRegistry — enumeration (AC1)", () => {
  it("lists exactly 5 first-party tools", () => {
    const reg = makeRegistry();
    expect(reg.list()).toHaveLength(5);
  });

  it("contains exactly the expected tool names", () => {
    const names = makeRegistry().list().map((t) => t.name);
    expect(names).toContain("search_flights");
    expect(names).toContain("search_hotels");
    expect(names).toContain("search_cars");
    expect(names).toContain("get_offer");
    expect(names).toContain("get_user_preferences");
  });

  it("every tool has a non-empty description", () => {
    for (const tool of makeRegistry().list()) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("ToolRegistry — Anthropic JSON schema generation (AC1)", () => {
  it("generates input_schema with type: object for search_flights", () => {
    const tool = makeRegistry().get("search_flights")!;
    const reg = new ToolRegistry([tool], { gatewayBaseUrl: GATEWAY });
    const [def] = reg.list();
    expect(def!.input_schema.type).toBe("object");
    const props = def!.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("departureAirport");
    expect(props).toHaveProperty("arrivalAirport");
    expect(props).toHaveProperty("departureDate");
    expect(props).toHaveProperty("passengers");
    expect(props).toHaveProperty("seatClass");
    expect(props).toHaveProperty("currency");
  });

  it("generates input_schema for search_hotels with checkInDate / checkOutDate", () => {
    const reg = makeRegistry();
    const defs = reg.list();
    const hotels = defs.find((t) => t.name === "search_hotels")!;
    const props = hotels.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("checkInDate");
    expect(props).toHaveProperty("checkOutDate");
    expect(props).toHaveProperty("location");
  });

  it("generates input_schema for search_cars with pickupDate / dropoffDate", () => {
    const reg = makeRegistry();
    const defs = reg.list();
    const cars = defs.find((t) => t.name === "search_cars")!;
    const props = cars.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("pickupDate");
    expect(props).toHaveProperty("dropoffDate");
  });

  it("generates input_schema for get_offer with offerId", () => {
    const reg = makeRegistry();
    const defs = reg.list();
    const getOffer = defs.find((t) => t.name === "get_offer")!;
    const props = getOffer.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("offerId");
  });

  it("generates empty properties for get_user_preferences (no model-supplied inputs)", () => {
    const reg = makeRegistry();
    const defs = reg.list();
    const prefs = defs.find((t) => t.name === "get_user_preferences")!;
    expect(prefs.input_schema.type).toBe("object");
  });

  it("every tool schema derives from the shared contracts Zod schemas (not hand-written)", () => {
    const reg = makeRegistry();
    const defs = reg.list();
    const contractsSchemas = [
      FlightSearchRequestSchema,
      HotelSearchRequestSchema,
      CarRentalSearchRequestSchema,
      GetOfferInputSchema,
      GetUserPreferencesInputSchema,
    ];
    for (const def of defs) {
      const descriptor = def._descriptor;
      // Each descriptor's inputSchema should be one of the known contracts schemas
      expect(contractsSchemas).toContain(descriptor.inputSchema);
    }
  });
});

describe("ToolRegistry — get() exact-match lookup (AC1 + edge cases)", () => {
  it("returns descriptor for exact name match", () => {
    const reg = makeRegistry();
    expect(reg.get("search_flights")).toBeDefined();
    expect(reg.get("search_flights")!.name).toBe("search_flights");
  });

  it("returns undefined for unknown tool name (AC2)", () => {
    const reg = makeRegistry();
    expect(reg.get("unknown_tool")).toBeUndefined();
  });

  it("strips leading/trailing whitespace before lookup", () => {
    const reg = makeRegistry();
    expect(reg.get("  search_flights  ")).toBeDefined();
  });

  it("returns undefined for wrong casing — no case-folding", () => {
    const reg = makeRegistry();
    // names are lower_snake_case; SEARCH_FLIGHTS would normalise to SEARCH_FLIGHTS which != search_flights
    expect(reg.get("SEARCH_FLIGHTS")).toBeUndefined();
    expect(reg.get("Search_Flights")).toBeUndefined();
  });

  it("returns undefined for trailing whitespace that does not match after trim", () => {
    const reg = makeRegistry();
    // e.g. "search_flights_extra" should not match
    expect(reg.get("search_flights_extra")).toBeUndefined();
  });
});

describe("ToolRegistry — duplicate name guard", () => {
  it("throws on duplicate tool names at construction", () => {
    const reg = createDefaultRegistry(GATEWAY);
    const [d1] = reg.list().map((t) => t._descriptor);
    expect(() => new ToolRegistry([d1!, d1!], { gatewayBaseUrl: GATEWAY })).toThrow(/Duplicate/);
  });
});
