/**
 * AI tools registry test (updated for WO-056 ToolRegistry).
 *
 * AC1: ToolRegistry exposes exactly the declared 5 first-party tools and
 *      returns Anthropic-compatible definitions generated from contracts Zod schemas.
 * AC8 (legacy): backward-compat validateToolInput rejects schema violations before
 *      any first-party search endpoint is invoked.
 */
import { describe, it, expect } from "vitest";
import {
  SEARCH_TOOLS,
  TOOL_BY_NAME,
  validateToolInput,
  createDefaultRegistry,
} from "../src/tools.js";
import {
  FlightSearchRequestSchema,
  HotelSearchRequestSchema,
  CarRentalSearchRequestSchema,
  CHECK_OUT_AFTER_CHECK_IN_MESSAGE,
  DROPOFF_AFTER_PICKUP_MESSAGE,
} from "@travel/contracts";
import { IATA_CODE_MESSAGE } from "@travel/contracts/common";

const GATEWAY = "http://localhost:8080";

describe("ToolRegistry — full 5-tool set (AC1)", () => {
  it("contains exactly five first-party tools", () => {
    const reg = createDefaultRegistry(GATEWAY);
    expect(reg.list()).toHaveLength(5);
  });

  it("contains all required tool names", () => {
    const reg = createDefaultRegistry(GATEWAY);
    const names = reg.list().map((t) => t.name);
    expect(names).toContain("search_flights");
    expect(names).toContain("search_hotels");
    expect(names).toContain("search_cars");
    expect(names).toContain("get_offer");
    expect(names).toContain("get_user_preferences");
  });

  it("every tool has a non-empty description", () => {
    const reg = createDefaultRegistry(GATEWAY);
    for (const tool of reg.list()) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("SEARCH_TOOLS legacy registry", () => {
  it("contains exactly three first-party search tools", () => {
    expect(SEARCH_TOOLS).toHaveLength(3);
    const names = SEARCH_TOOLS.map((t) => t.name);
    expect(names).toContain("search_flights");
    expect(names).toContain("search_hotels");
    expect(names).toContain("search_cars");
  });

  it("AC8 — every tool has a _contractsSchema reference (not hand-written)", () => {
    for (const tool of SEARCH_TOOLS) {
      expect(tool._contractsSchema).toBeDefined();
      const known = [FlightSearchRequestSchema, HotelSearchRequestSchema, CarRentalSearchRequestSchema];
      expect(known).toContain(tool._contractsSchema);
    }
  });

  it("search_flights tool has non-empty input_schema with properties", () => {
    const tool = TOOL_BY_NAME.get("search_flights")!;
    expect(tool.input_schema.type).toBe("object");
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("departureAirport");
    expect(props).toHaveProperty("arrivalAirport");
    expect(props).toHaveProperty("departureDate");
    expect(props).toHaveProperty("passengers");
    expect(props).toHaveProperty("seatClass");
    expect(props).toHaveProperty("currency");
  });

  it("search_hotels tool has checkInDate and checkOutDate in schema", () => {
    const tool = TOOL_BY_NAME.get("search_hotels")!;
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("checkInDate");
    expect(props).toHaveProperty("checkOutDate");
    expect(props).toHaveProperty("location");
  });

  it("search_cars tool has pickupDate and dropoffDate in schema", () => {
    const tool = TOOL_BY_NAME.get("search_cars")!;
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("pickupDate");
    expect(props).toHaveProperty("dropoffDate");
  });
});

describe("validateToolInput — AC8 rejection before search endpoint", () => {
  const VALID_FLIGHT = {
    departureAirport: "JFK",
    arrivalAirport: "LAX",
    departureDate: "2030-06-01T00:00:00.000Z",
    passengers: 2,
    seatClass: "ECONOMY",
    currency: "USD",
  };

  it("AC8 — rejects four-letter airport code (model cannot emit invalid tool call)", () => {
    const result = validateToolInput("search_flights", {
      ...VALID_FLIGHT,
      departureAirport: "JFKX",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe(IATA_CODE_MESSAGE);
  });

  it("AC8 — rejects hotel checkout not after checkin", () => {
    const result = validateToolInput("search_hotels", {
      location: "Paris",
      checkInDate: "2030-06-05T00:00:00.000Z",
      checkOutDate: "2030-06-01T00:00:00.000Z",
      guests: 2,
      currency: "EUR",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages).toContain(CHECK_OUT_AFTER_CHECK_IN_MESSAGE);
  });

  it("AC8 — rejects car dropoff before pickup", () => {
    const result = validateToolInput("search_cars", {
      pickupLocation: "LAX",
      dropoffLocation: "LAX",
      pickupDate: "2030-06-05T00:00:00.000Z",
      dropoffDate: "2030-06-01T00:00:00.000Z",
      carClass: "ECONOMY",
      currency: "USD",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages).toContain(DROPOFF_AFTER_PICKUP_MESSAGE);
  });

  it("returns success with parsed data for valid flight tool call", () => {
    const result = validateToolInput("search_flights", VALID_FLIGHT);
    expect(result.success).toBe(true);
  });

  it("returns failure for unknown tool name", () => {
    const result = validateToolInput("unknown_tool", {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("Unknown tool");
  });

  it("rejects extra properties on strict schema (injection guard)", () => {
    const result = validateToolInput("search_flights", {
      ...VALID_FLIGHT,
      __proto__: { admin: true },
    });
    expect(result.success).toBe(false);
  });
});
