/**
 * Validation micro-benchmark.
 *
 * AC9: Asserts that parsing a representative flight search payload stays
 *      within the 8 ms budget defined in the architecture for the ~180 ms
 *      p95 cache-hit search path.
 *
 * Method: run 1000 iterations and assert median duration < 8 ms.
 * The benchmark is deliberately conservative — it runs in a CI container
 * without any warm-up JIT optimisations.
 */
import { describe, it, expect } from "vitest";
import { FlightSearchRequestSchema } from "@travel/contracts";
import { validateRequest } from "../validateRequest.js";
import { ErrorCode } from "@travel/contracts";

const VALID_FLIGHT = {
  departureAirport: "JFK",
  arrivalAirport: "LAX",
  departureDate: "2030-06-01T00:00:00.000Z",
  passengers: 2,
  seatClass: "ECONOMY",
  currency: "USD",
};

// Compile once at module scope — mirrors production usage.
const validator = validateRequest({ body: FlightSearchRequestSchema });

describe("validation benchmark — AC9", () => {
  it("parses a valid flight payload in under 8 ms (median over 1000 runs)", () => {
    const iterations = 1000;
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const req = {
        body: VALID_FLIGHT,
        query: {},
        params: {},
        headers: {},
        validated: undefined,
      };
      const res = {
        headersSent: false,
        _status: 0,
        status(code: number) { this._status = code; return this; },
        json(body: unknown) { return this; },
      };
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      const start = performance.now();
      validator(req as never, res as never, next);
      durations.push(performance.now() - start);

      expect(nextCalled).toBe(true);
    }

    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(iterations / 2)]!;

    // Budget: 8 ms per the architecture doc (~180 ms p95 search path).
    expect(median).toBeLessThan(8);
  });

  it("parses an invalid flight payload (short-circuit) in under 8 ms (median)", () => {
    const iterations = 1000;
    const durations: number[] = [];
    const invalidBody = { ...VALID_FLIGHT, departureAirport: "JFKX" };

    for (let i = 0; i < iterations; i++) {
      const req = {
        body: invalidBody,
        query: {},
        params: {},
        headers: {},
        validated: undefined,
      };
      const res = {
        headersSent: false,
        _status: 0,
        _body: undefined as unknown,
        status(code: number) { this._status = code; return this; },
        json(body: unknown) { this._body = body; return this; },
      };

      const start = performance.now();
      validator(req as never, res as never, () => {});
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(iterations / 2)]!;
    expect(median).toBeLessThan(8);
  });
});
