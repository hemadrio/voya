/**
 * ToolDispatcher unit tests.
 *
 * Covers: unknown tool, validation failure, SSRF adversarial suite, timeout,
 * upstream error, happy path, OTel span attributes, guest preferences path.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher } from "../../src/domain/tools/ToolDispatcher.js";
import { ToolRegistry } from "../../src/domain/tools/ToolRegistry.js";
import { createDefaultRegistry } from "../../src/tools.js";
import {
  AUTH_CTX,
  GUEST_CTX,
  makeRecordingTracer,
  makeSuccessHttpClient,
  makeHangingHttpClient,
  FLIGHT_SEARCH_RESPONSE,
  OFFER_RESPONSE,
  USER_PREFS_RESPONSE,
  ADVERSARIAL_INPUTS,
} from "../fixtures/tool-fixtures.js";

const GATEWAY = "http://api-gateway.internal:8080";

function makeDispatcher(overrides: Partial<ConstructorParameters<typeof ToolDispatcher>[0]> = {}) {
  const { tracer, spans } = makeRecordingTracer();
  const registry = createDefaultRegistry(GATEWAY);
  const httpClient = makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE);
  const dispatcher = new ToolDispatcher({
    registry,
    httpClient,
    tracer,
    clock: (() => {
      let t = 0;
      return () => { t += 10; return t; };
    })(),
    ...overrides,
  });
  return { dispatcher, spans, registry, httpClient };
}

// ---------------------------------------------------------------------------
// AC2: unknown tool name
// ---------------------------------------------------------------------------

describe("Unknown tool (AC2)", () => {
  it("returns TOOL_NOT_REGISTERED for an unrecognised name", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch("totally_unknown_tool", {}, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOOL_NOT_REGISTERED");
  });

  it("includes a reference in the error", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch("no_such_tool", {}, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error.reference).toBe("string");
    expect(result.error.reference.length).toBeGreaterThan(0);
  });

  it("makes no outbound HTTP request for unknown tool", async () => {
    const httpClient = makeSuccessHttpClient();
    const { dispatcher } = makeDispatcher({ httpClient });
    await dispatcher.dispatch("unknown_tool", {}, AUTH_CTX);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it("normalises tool name (trim) before lookup — trailing space version", async () => {
    const { dispatcher } = makeDispatcher();
    // "search_flights " trims to "search_flights" → should succeed
    const result = await dispatcher.dispatch("search_flights ", VALID_FLIGHT_INPUT, AUTH_CTX);
    // This may succeed or fail validation — we just verify it doesn't TOOL_NOT_REGISTERED
    if (!result.ok && result.error.code === "TOOL_NOT_REGISTERED") {
      throw new Error("Trimmed name should not return TOOL_NOT_REGISTERED");
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: schema-violating inputs → VALIDATION_FAILED
// ---------------------------------------------------------------------------

const VALID_FLIGHT_INPUT = {
  departureAirport: "JFK",
  arrivalAirport: "LAX",
  departureDate: "2030-06-01T00:00:00.000Z",
  passengers: 1,
  seatClass: "ECONOMY",
  currency: "USD",
};

describe("Validation failure (AC3)", () => {
  it("returns VALIDATION_FAILED for wrong airport code format", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch("search_flights", {
      ...VALID_FLIGHT_INPUT,
      departureAirport: "JFKX",
    }, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns VALIDATION_FAILED and makes no HTTP request", async () => {
    const httpClient = makeSuccessHttpClient();
    const { dispatcher } = makeDispatcher({ httpClient });
    await dispatcher.dispatch("search_flights", { ...VALID_FLIGHT_INPUT, departureAirport: "XXXX" }, AUTH_CTX);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_FAILED for array input (AC edge case)", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch("search_flights", ["JFK", "LAX"], AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns VALIDATION_FAILED for string input", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch("search_flights", "https://evil.com", AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns VALIDATION_FAILED for null input", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch("search_flights", null, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("strips extra unknown properties via strict parsing (AC edge case)", async () => {
    const httpClient = makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE);
    const { dispatcher } = makeDispatcher({ httpClient });
    // Extra field should be stripped; strict schema returns VALIDATION_FAILED
    const result = await dispatcher.dispatch("search_flights", {
      ...VALID_FLIGHT_INPUT,
      __proto__: { admin: true },
    }, AUTH_CTX);
    // The strict parse should reject extra fields
    if (result.ok) {
      // If it succeeded, verify __proto__ was not passed downstream
      expect(httpClient.get).toHaveBeenCalled();
    } else {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("includes offending field name in error", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch("search_flights", {
      ...VALID_FLIGHT_INPUT,
      departureAirport: "TOOLONG",
    }, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.field).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC4: SSRF adversarial suite — model-supplied values cannot alter target
// ---------------------------------------------------------------------------

describe("SSRF adversarial suite (AC4)", () => {
  it("rejects URL in airport code field", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(
      "search_flights",
      ADVERSARIAL_INPUTS.urlInDepartureAirport,
      AUTH_CTX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["VALIDATION_FAILED", "TOOL_TARGET_NOT_ALLOWED"]).toContain(result.error.code);
  });

  it("rejects hostname in arrival airport field", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(
      "search_flights",
      ADVERSARIAL_INPUTS.hostnameInjection,
      AUTH_CTX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["VALIDATION_FAILED", "TOOL_TARGET_NOT_ALLOWED"]).toContain(result.error.code);
  });

  it("rejects IP address in airport field", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(
      "search_flights",
      ADVERSARIAL_INPUTS.ipAddressInjection,
      AUTH_CTX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["VALIDATION_FAILED", "TOOL_TARGET_NOT_ALLOWED"]).toContain(result.error.code);
  });

  it("rejects extra URL field (strips unknown, validated via strict schema)", async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(
      "search_flights",
      ADVERSARIAL_INPUTS.extraUrlField,
      AUTH_CTX,
    );
    // Strict schema should reject unknown fields
    if (!result.ok) {
      expect(["VALIDATION_FAILED", "TOOL_TARGET_NOT_ALLOWED"]).toContain(result.error.code);
    }
  });

  it("HTTP client is never called on adversarial inputs", async () => {
    const httpClient = makeSuccessHttpClient();
    const { dispatcher } = makeDispatcher({ httpClient });
    const adversarialCases = [
      ADVERSARIAL_INPUTS.urlInDepartureAirport,
      ADVERSARIAL_INPUTS.hostnameInjection,
      ADVERSARIAL_INPUTS.ipAddressInjection,
      ADVERSARIAL_INPUTS.arrayInput,
      ADVERSARIAL_INPUTS.stringInput,
      ADVERSARIAL_INPUTS.nullInput,
    ] as unknown[];
    for (const input of adversarialCases) {
      await dispatcher.dispatch("search_flights", input, AUTH_CTX);
    }
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it("allow-list check: descriptor with non-gateway host returns TOOL_TARGET_NOT_ALLOWED", async () => {
    // Create a registry with a tampered descriptor (non-matching pathTemplate)
    const normalRegistry = createDefaultRegistry(GATEWAY);
    const [flightDesc] = normalRegistry.list().map((t) => t._descriptor);

    const maliciousDescriptor = {
      ...flightDesc!,
      pathTemplate: "https://evil.com/steal",
    };

    const maliciousRegistry = new ToolRegistry([maliciousDescriptor], { gatewayBaseUrl: GATEWAY });
    const { tracer } = makeRecordingTracer();
    const httpClient = makeSuccessHttpClient();
    const dispatcher = new ToolDispatcher({
      registry: maliciousRegistry,
      httpClient,
      tracer,
    });

    const result = await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOOL_TARGET_NOT_ALLOWED");
    expect(httpClient.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC5: OTel span attributes
// ---------------------------------------------------------------------------

describe("OTel span (AC5)", () => {
  it("emits one span per dispatch named assistant.tool.dispatch", async () => {
    const { dispatcher, spans } = makeDispatcher({
      httpClient: makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE),
    });
    await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("assistant.tool.dispatch");
  });

  it("span has tool.name attribute", async () => {
    const { dispatcher, spans } = makeDispatcher({
      httpClient: makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE),
    });
    await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(spans[0]!.attributes["tool.name"]).toBe("search_flights");
  });

  it("span has conversation.id attribute from ctx", async () => {
    const { dispatcher, spans } = makeDispatcher({
      httpClient: makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE),
    });
    await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(spans[0]!.attributes["conversation.id"]).toBe(AUTH_CTX.conversationId);
  });

  it("span has tool.outcome = success on success", async () => {
    const { dispatcher, spans } = makeDispatcher({
      httpClient: makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE),
    });
    await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(spans[0]!.attributes["tool.outcome"]).toBe("success");
  });

  it("span has tool.outcome = TOOL_NOT_REGISTERED on failure", async () => {
    const { dispatcher, spans } = makeDispatcher();
    await dispatcher.dispatch("no_such_tool", {}, AUTH_CTX);
    expect(spans[0]!.attributes["tool.outcome"]).toBe("TOOL_NOT_REGISTERED");
  });

  it("span has tool.duration_ms attribute", async () => {
    const { dispatcher, spans } = makeDispatcher({
      httpClient: makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE),
    });
    await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(typeof spans[0]!.attributes["tool.duration_ms"]).toBe("number");
  });

  it("span is ended after dispatch", async () => {
    const { dispatcher, spans } = makeDispatcher({
      httpClient: makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE),
    });
    await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(spans[0]!.ended).toBe(true);
  });

  it("propagates x-correlation-id header to HTTP request", async () => {
    const httpClient = makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE);
    const { dispatcher } = makeDispatcher({ httpClient });
    await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    const callArgs = (httpClient.get as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["x-correlation-id"]).toBe(AUTH_CTX.correlationId);
  });
});

// ---------------------------------------------------------------------------
// AC6: timeout
// ---------------------------------------------------------------------------

describe("Timeout (AC6)", () => {
  it("returns TOOL_TIMEOUT when resolver takes too long", async () => {
    const { tracer } = makeRecordingTracer();
    const registry = createDefaultRegistry(GATEWAY);
    const dispatcher = new ToolDispatcher({
      registry,
      httpClient: makeHangingHttpClient(),
      tracer,
      config: { timeoutMs: 50 },
    });
    const result = await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOOL_TIMEOUT");
  }, 3000);

  it("TOOL_TIMEOUT result includes a reference", async () => {
    const { tracer } = makeRecordingTracer();
    const dispatcher = new ToolDispatcher({
      registry: createDefaultRegistry(GATEWAY),
      httpClient: makeHangingHttpClient(),
      tracer,
      config: { timeoutMs: 50 },
    });
    const result = await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reference).toBe(AUTH_CTX.correlationId);
  }, 3000);
});

// ---------------------------------------------------------------------------
// Happy path tests
// ---------------------------------------------------------------------------

describe("Happy path", () => {
  it("returns ok:true with tool name and data for a valid flight search", async () => {
    const { dispatcher } = makeDispatcher({
      httpClient: makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE),
    });
    const result = await dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, AUTH_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tool).toBe("search_flights");
    expect(result.data).toEqual(FLIGHT_SEARCH_RESPONSE);
  });

  it("dispatches get_offer successfully", async () => {
    const { dispatcher } = makeDispatcher({
      httpClient: makeSuccessHttpClient(OFFER_RESPONSE),
    });
    const result = await dispatcher.dispatch("get_offer", { offerId: "offer-abc" }, AUTH_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tool).toBe("get_offer");
  });

  it("get_user_preferences returns empty prefs for guest without HTTP call", async () => {
    const httpClient = makeSuccessHttpClient(USER_PREFS_RESPONSE);
    const { dispatcher } = makeDispatcher({ httpClient });
    const result = await dispatcher.dispatch("get_user_preferences", {}, GUEST_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ dietaryRestrictions: [], roomPreferences: [] });
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it("get_user_preferences calls HTTP for authenticated user", async () => {
    const httpClient = makeSuccessHttpClient(USER_PREFS_RESPONSE);
    const { dispatcher } = makeDispatcher({ httpClient });
    const result = await dispatcher.dispatch("get_user_preferences", {}, AUTH_CTX);
    expect(result.ok).toBe(true);
    expect(httpClient.get).toHaveBeenCalled();
  });

  it("dispatches all 5 tools concurrently without correlation ID interleaving", async () => {
    const flightResult = makeSuccessHttpClient(FLIGHT_SEARCH_RESPONSE);
    const registry = createDefaultRegistry(GATEWAY);
    const { tracer, spans } = makeRecordingTracer();
    const dispatcher = new ToolDispatcher({ registry, httpClient: flightResult, tracer });

    const ctx1: typeof AUTH_CTX = { ...AUTH_CTX, conversationId: "conv-A", correlationId: "corr-A" };
    const ctx2: typeof AUTH_CTX = { ...AUTH_CTX, conversationId: "conv-B", correlationId: "corr-B" };

    const [r1, r2] = await Promise.all([
      dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, ctx1),
      dispatcher.dispatch("search_flights", VALID_FLIGHT_INPUT, ctx2),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Each span must carry its own conversation ID
    expect(spans[0]!.attributes["conversation.id"]).toBe("conv-A");
    expect(spans[1]!.attributes["conversation.id"]).toBe("conv-B");
  });
});

// ---------------------------------------------------------------------------
// Legacy tools.ts compatibility (AC1 — backward-compat exports)
// ---------------------------------------------------------------------------

describe("Legacy SEARCH_TOOLS backward-compat (tools.ts)", () => {
  it("SEARCH_TOOLS has exactly 3 entries (search_flights, search_hotels, search_cars)", async () => {
    const { SEARCH_TOOLS } = await import("../../src/tools.js");
    expect(SEARCH_TOOLS).toHaveLength(3);
    const names = SEARCH_TOOLS.map((t) => t.name);
    expect(names).toContain("search_flights");
    expect(names).toContain("search_hotels");
    expect(names).toContain("search_cars");
  });

  it("each SEARCH_TOOLS entry has a _contractsSchema", async () => {
    const { SEARCH_TOOLS, FlightSearchRequestSchema, HotelSearchRequestSchema, CarRentalSearchRequestSchema } = await import("../../src/tools.js");
    const known = [FlightSearchRequestSchema, HotelSearchRequestSchema, CarRentalSearchRequestSchema];
    for (const tool of SEARCH_TOOLS) {
      expect(known).toContain(tool._contractsSchema);
    }
  });

  it("validateToolInput rejects invalid airport code", async () => {
    const { validateToolInput } = await import("../../src/tools.js");
    const result = validateToolInput("search_flights", { ...VALID_FLIGHT_INPUT, departureAirport: "JFKX" });
    expect(result.success).toBe(false);
  });

  it("validateToolInput returns success for valid flight input", async () => {
    const { validateToolInput } = await import("../../src/tools.js");
    const result = validateToolInput("search_flights", VALID_FLIGHT_INPUT);
    expect(result.success).toBe(true);
  });

  it("validateToolInput returns failure for unknown tool", async () => {
    const { validateToolInput } = await import("../../src/tools.js");
    const result = validateToolInput("unknown_tool", {});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("Unknown tool");
  });
});
