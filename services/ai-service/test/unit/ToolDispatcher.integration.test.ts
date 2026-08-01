/**
 * ToolDispatcher integration tests (AC8).
 *
 * Validates that each registered tool reaches the correct gateway route,
 * carries the x-correlation-id header, and returns normalised data.
 *
 * Uses a real in-process Node.js HTTP server as the stub gateway and
 * Node.js 20 native fetch for the HttpClientPort — no nock required.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ToolDispatcher } from "../../src/domain/tools/ToolDispatcher.js";
import { createDefaultRegistry } from "../../src/tools.js";
import type { HttpClientPort, HttpResponse } from "../../src/domain/tools/ToolDescriptor.js";
import {
  FLIGHT_SEARCH_RESPONSE,
  HOTEL_SEARCH_RESPONSE,
  CAR_SEARCH_RESPONSE,
  OFFER_RESPONSE,
  USER_PREFS_RESPONSE,
  AUTH_CTX,
  GUEST_CTX,
} from "../fixtures/tool-fixtures.js";

// ---------------------------------------------------------------------------
// Real HttpClientPort using Node 20 native fetch
// ---------------------------------------------------------------------------

function makeRealHttpClient(): HttpClientPort {
  return {
    async get(url, { headers, signal }): Promise<HttpResponse> {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: signal as AbortSignal,
      });
      return {
        status: response.status,
        json: () => response.json() as Promise<unknown>,
        text: () => response.text(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stub gateway server
// ---------------------------------------------------------------------------

/** Map of path prefix → response body. */
const ROUTE_MAP: Record<string, unknown> = {
  "/v1/search/flights": FLIGHT_SEARCH_RESPONSE,
  "/v1/search/hotels": HOTEL_SEARCH_RESPONSE,
  "/v1/search/cars": CAR_SEARCH_RESPONSE,
  "/v1/offers": OFFER_RESPONSE,
  "/v1/users/preferences": USER_PREFS_RESPONSE,
};

/** Captured requests for assertion. */
const CAPTURED: Array<{ method: string; path: string; headers: Record<string, string> }> = [];

let server: http.Server;
let gatewayBaseUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const url = req.url ?? "/";
        const pathname = url.split("?")[0] ?? "/";
        const correlationId = req.headers["x-correlation-id"] as string | undefined;

        CAPTURED.push({
          method: req.method ?? "GET",
          path: pathname,
          headers: { "x-correlation-id": correlationId ?? "" },
        });

        const body = Object.entries(ROUTE_MAP).find(([prefix]) => pathname.startsWith(prefix));
        if (body !== undefined) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body[1]));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        gatewayBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

// ---------------------------------------------------------------------------
// Valid inputs
// ---------------------------------------------------------------------------

const VALID_FLIGHT = {
  departureAirport: "JFK",
  arrivalAirport: "LAX",
  departureDate: "2030-06-01T00:00:00.000Z",
  passengers: 1,
  seatClass: "ECONOMY",
  currency: "USD",
};

const VALID_HOTEL = {
  location: "Paris",
  checkInDate: "2030-06-01T00:00:00.000Z",
  checkOutDate: "2030-06-05T00:00:00.000Z",
  guests: 2,
  currency: "EUR",
};

const VALID_CAR = {
  pickupLocation: "LAX",
  dropoffLocation: "LAX",
  pickupDate: "2030-06-01T00:00:00.000Z",
  dropoffDate: "2030-06-05T00:00:00.000Z",
  carClass: "ECONOMY",
  currency: "USD",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDispatcher() {
  const registry = createDefaultRegistry(gatewayBaseUrl);
  const httpClient = makeRealHttpClient();
  return new ToolDispatcher({ registry, httpClient });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: each tool reaches correct gateway route (AC8)", () => {
  it("search_flights hits /v1/search/flights and returns data", async () => {
    const dispatcher = makeDispatcher();
    const before = CAPTURED.length;
    const result = await dispatcher.dispatch("search_flights", VALID_FLIGHT, AUTH_CTX);
    expect(result.ok).toBe(true);
    const req = CAPTURED[before];
    expect(req?.path).toBe("/v1/search/flights");
    expect(req?.method).toBe("GET");
  });

  it("search_hotels hits /v1/search/hotels and returns data", async () => {
    const dispatcher = makeDispatcher();
    const before = CAPTURED.length;
    const result = await dispatcher.dispatch("search_hotels", VALID_HOTEL, AUTH_CTX);
    expect(result.ok).toBe(true);
    const req = CAPTURED[before];
    expect(req?.path).toBe("/v1/search/hotels");
  });

  it("search_cars hits /v1/search/cars and returns data", async () => {
    const dispatcher = makeDispatcher();
    const before = CAPTURED.length;
    const result = await dispatcher.dispatch("search_cars", VALID_CAR, AUTH_CTX);
    expect(result.ok).toBe(true);
    const req = CAPTURED[before];
    expect(req?.path).toBe("/v1/search/cars");
  });

  it("get_offer hits /v1/offers and returns data", async () => {
    const dispatcher = makeDispatcher();
    const before = CAPTURED.length;
    const result = await dispatcher.dispatch("get_offer", { offerId: "offer-123" }, AUTH_CTX);
    expect(result.ok).toBe(true);
    const req = CAPTURED[before];
    expect(req?.path).toBe("/v1/offers");
  });

  it("each request carries x-correlation-id header", async () => {
    const dispatcher = makeDispatcher();
    const before = CAPTURED.length;
    await dispatcher.dispatch("search_flights", VALID_FLIGHT, AUTH_CTX);
    const req = CAPTURED[before];
    expect(req?.headers["x-correlation-id"]).toBe(AUTH_CTX.correlationId);
  });
});

describe("Integration: get_user_preferences guest path (AC8)", () => {
  it("guest context does not hit gateway — returns empty prefs immediately", async () => {
    const dispatcher = makeDispatcher();
    const before = CAPTURED.length;
    const result = await dispatcher.dispatch("get_user_preferences", {}, GUEST_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ dietaryRestrictions: [], roomPreferences: [] });
    // No new request should have been made to the stub server
    expect(CAPTURED.length).toBe(before);
  });

  it("authenticated user hits /v1/users/preferences", async () => {
    const dispatcher = makeDispatcher();
    const before = CAPTURED.length;
    const result = await dispatcher.dispatch("get_user_preferences", {}, AUTH_CTX);
    expect(result.ok).toBe(true);
    const req = CAPTURED[before];
    expect(req?.path).toBe("/v1/users/preferences");
  });
});

describe("Integration: normalised output matches output schema (AC8)", () => {
  it("search_flights output is an array", async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch("search_flights", VALID_FLIGHT, AUTH_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("get_offer output has id, provenance, bookable fields", async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch("get_offer", { offerId: "offer-abc" }, AUTH_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as typeof OFFER_RESPONSE;
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("provenance");
    expect(data).toHaveProperty("bookable");
  });
});
