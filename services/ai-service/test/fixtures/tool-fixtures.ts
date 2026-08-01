/**
 * Shared fixtures for ToolRegistry and ToolDispatcher unit tests.
 *
 * Provides: RecordingTracer, makeHttpClient, gateway responses, adversarial inputs.
 * All fixtures are offline — no network access.
 */
import { vi } from "vitest";
import type { HttpClientPort, HttpResponse, SpanLike, TracerLike, ToolContext } from "../../src/domain/tools/ToolDescriptor.js";

// ---------------------------------------------------------------------------
// RecordingTracer — captures span attributes for assertion
// ---------------------------------------------------------------------------

export interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  statusCode: 0 | 1 | 2;
  ended: boolean;
}

export function makeRecordingTracer(): { tracer: TracerLike; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  const tracer: TracerLike = {
    startActiveSpan<T>(name: string, fn: (span: SpanLike) => T): T {
      const recorded: RecordedSpan = { name, attributes: {}, statusCode: 0, ended: false };
      spans.push(recorded);
      let spanRef: SpanLike;
      spanRef = {
        setAttribute(key, value) { recorded.attributes[key] = value; return spanRef; },
        setStatus(status) { recorded.statusCode = status.code; return spanRef; },
        end() { recorded.ended = true; },
      };
      return fn(spanRef);
    },
  };

  return { tracer, spans };
}

// ---------------------------------------------------------------------------
// Context fixtures
// ---------------------------------------------------------------------------

export const AUTH_CTX: ToolContext = {
  conversationId: "conv-001",
  correlationId: "corr-001",
  userId: "user-123",
  authToken: "tok-abc",
};

export const GUEST_CTX: ToolContext = {
  conversationId: "conv-002",
  correlationId: "corr-002",
  userId: null,
};

// ---------------------------------------------------------------------------
// Mock HTTP client helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** HTTP client that returns a 200 JSON response for any GET call. */
export function makeSuccessHttpClient(body: unknown = { ok: true }): HttpClientPort {
  return {
    get: vi.fn().mockResolvedValue(makeJsonResponse(200, body)),
  };
}

/** HTTP client that returns a 500 for any GET call. */
export function makeErrorHttpClient(status = 500): HttpClientPort {
  return {
    get: vi.fn().mockResolvedValue(makeJsonResponse(status, { error: "upstream error" })),
  };
}

/** HTTP client that never resolves (simulates timeout). */
export function makeHangingHttpClient(): HttpClientPort {
  return {
    get: vi.fn().mockImplementation(
      (_url: string, { signal }: { signal: AbortSignal }) =>
        new Promise<HttpResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Canned gateway responses
// ---------------------------------------------------------------------------

export const FLIGHT_SEARCH_RESPONSE = [
  {
    id: "flight-001",
    provenance: "AMADEUS",
    bookable: true,
    title: "LHR → JFK",
    price: 412.5,
    currency: "USD",
  },
];

export const HOTEL_SEARCH_RESPONSE = [
  {
    id: "hotel-001",
    provenance: "RAPIDAPI_HOTEL",
    bookable: true,
    title: "Marriott Paris",
    price: 189.0,
    currency: "EUR",
  },
];

export const CAR_SEARCH_RESPONSE = [
  {
    id: "car-001",
    provenance: "RAPIDAPI_CAR",
    bookable: true,
    title: "Economy Hertz",
    price: 75.0,
    currency: "USD",
  },
];

export const OFFER_RESPONSE = {
  id: "offer-abc",
  provenance: "AMADEUS",
  bookable: true,
  price: 412.5,
  currency: "USD",
};

export const USER_PREFS_RESPONSE = {
  seatClass: "BUSINESS",
  dietaryRestrictions: ["VEGAN"],
  roomPreferences: ["NON_SMOKING"],
};

// ---------------------------------------------------------------------------
// Adversarial tool inputs (model-supplied injection attempts)
// ---------------------------------------------------------------------------

export const ADVERSARIAL_INPUTS = {
  /** URL injected into a normal string field. */
  urlInDepartureAirport: {
    departureAirport: "https://evil.com/steal",
    arrivalAirport: "LAX",
    departureDate: "2030-06-01T00:00:00.000Z",
    passengers: 1,
    seatClass: "ECONOMY",
    currency: "USD",
  },

  /** Hostname injected as a field value. */
  hostnameInjection: {
    departureAirport: "JFK",
    arrivalAirport: "evil.com",
    departureDate: "2030-06-01T00:00:00.000Z",
    passengers: 1,
    seatClass: "ECONOMY",
    currency: "USD",
  },

  /** IP address in a field. */
  ipAddressInjection: {
    departureAirport: "JFK",
    arrivalAirport: "192.168.0.1",
    departureDate: "2030-06-01T00:00:00.000Z",
    passengers: 1,
    seatClass: "ECONOMY",
    currency: "USD",
  },

  /** Extra unknown field containing a URL (attempt to pass extra params). */
  extraUrlField: {
    departureAirport: "JFK",
    arrivalAirport: "LAX",
    departureDate: "2030-06-01T00:00:00.000Z",
    passengers: 1,
    seatClass: "ECONOMY",
    currency: "USD",
    __redirectTo: "https://evil.com",
  },

  /** Array input instead of object. */
  arrayInput: ["JFK", "LAX"],

  /** String input. */
  stringInput: "https://evil.com",

  /** Null input. */
  nullInput: null,

  /** Header-like object attempt. */
  headerLikeField: {
    departureAirport: "JFK",
    arrivalAirport: "LAX",
    departureDate: "2030-06-01T00:00:00.000Z",
    passengers: 1,
    seatClass: "ECONOMY",
    currency: "USD",
    "Authorization: Bearer evil": "injected",
  },
} as const;
