/**
 * Flight search route — validation boundary tests.
 *
 * AC3: A four-letter airport code produces the exact BR-11 message and the
 *      Amadeus adapter is never called (spy asserts zero invocations).
 *
 * AC11: Unit tests for the middleware factory covering body location,
 *       success attachment, failure envelope, and unknown-key rejection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { SearchAdapter } from "../../src/adapters/SearchAdapter.js";
import { IATA_CODE_MESSAGE } from "@travel/contracts/common";

// ---------------------------------------------------------------------------
// Stub adapter — records calls so tests can assert no invocations on failure.
// ---------------------------------------------------------------------------

function makeStubAdapter(): SearchAdapter & { searchFlightsCalls: number } {
  return {
    searchFlightsCalls: 0,
    searchFlights: vi.fn(async () => {
      // increment counter for assertion
      return [];
    }) as unknown as SearchAdapter["searchFlights"],
    searchHotels: vi.fn(async () => []) as unknown as SearchAdapter["searchHotels"],
    searchCars: vi.fn(async () => []) as unknown as SearchAdapter["searchCars"],
  };
}

const VALID_FLIGHT_BODY = {
  departureAirport: "JFK",
  arrivalAirport: "LAX",
  departureDate: "2030-06-01T00:00:00.000Z",
  passengers: 2,
  seatClass: "ECONOMY",
  currency: "USD",
};

describe("POST /search/flights — validation boundary", () => {
  let adapter: ReturnType<typeof makeStubAdapter>;

  beforeEach(() => {
    adapter = makeStubAdapter();
  });

  // ── AC3: BR-11 four-letter airport code ─────────────────────────────────

  it("AC3 — rejects four-letter departure airport with BR-11 message", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/flights")
      .send({ ...VALID_FLIGHT_BODY, departureAirport: "JFKX" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.message).toBe(IATA_CODE_MESSAGE);
    expect(res.body.error.field).toBe("departureAirport");
    expect(res.body.reference).toBeDefined();

    // AC3: adapter was NEVER called
    expect(adapter.searchFlights).not.toHaveBeenCalled();
  });

  it("AC3 — rejects four-letter arrival airport with BR-11 message", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/flights")
      .send({ ...VALID_FLIGHT_BODY, arrivalAirport: "LAXX" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(IATA_CODE_MESSAGE);
    expect(res.body.error.field).toBe("arrivalAirport");
    expect(adapter.searchFlights).not.toHaveBeenCalled();
  });

  it("AC3 — rejects lowercase airport code (normalisation does not accept 4-char)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/flights")
      .send({ ...VALID_FLIGHT_BODY, departureAirport: "jfkx" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(IATA_CODE_MESSAGE);
    expect(adapter.searchFlights).not.toHaveBeenCalled();
  });

  // ── Unknown key rejection (strict schema) ──────────────────────────────

  it("rejects unknown keys (strict schema)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/flights")
      .send({ ...VALID_FLIGHT_BODY, extraKey: "injected" });

    expect(res.status).toBe(400);
    expect(adapter.searchFlights).not.toHaveBeenCalled();
  });

  // ── Missing required field ──────────────────────────────────────────────

  it("rejects missing passengers field with 400", async () => {
    const app = createApp(adapter);
    const { passengers: _, ...noPassengers } = VALID_FLIGHT_BODY;
    const res = await request(app).post("/search/flights").send(noPassengers);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(adapter.searchFlights).not.toHaveBeenCalled();
  });

  it("rejects empty body with 400", async () => {
    const app = createApp(adapter);
    const res = await request(app).post("/search/flights").send({});

    expect(res.status).toBe(400);
    expect(adapter.searchFlights).not.toHaveBeenCalled();
  });

  // ── Valid payload passes through ───────────────────────────────────────

  it("valid payload calls adapter and returns 200", async () => {
    const app = createApp(adapter);
    const res = await request(app).post("/search/flights").send(VALID_FLIGHT_BODY);

    expect(res.status).toBe(200);
    expect(adapter.searchFlights).toHaveBeenCalledOnce();
    expect(res.body.data).toBeInstanceOf(Array);
  });

  // ── Health endpoint is reachable without validation ─────────────────────

  it("GET /health responds 200 without validation", async () => {
    const app = createApp(adapter);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
