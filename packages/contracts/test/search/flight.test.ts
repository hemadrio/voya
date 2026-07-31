import { describe, expect, it } from "vitest";
import {
  FUTURE_DEPARTURE_DATE_MESSAGE,
  FlightSearchRequestSchema,
  PASSENGER_COUNT_MESSAGE,
  RETURN_DATE_NOT_BEFORE_DEPARTURE_MESSAGE,
} from "../../src/search/flight.js";
import { IATA_CODE_MESSAGE } from "../../src/common/primitives.js";

const future = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

const validPayload = () => ({
  departureAirport: "JFK",
  arrivalAirport: "LAX",
  departureDate: future(30 * 24 * 60 * 60 * 1000),
  returnDate: future(37 * 24 * 60 * 60 * 1000),
  passengers: 2,
  seatClass: "ECONOMY" as const,
  currency: "USD",
});

describe("FlightSearchRequestSchema", () => {
  it("accepts a valid payload without a return date", () => {
    const { returnDate: _returnDate, ...rest } = validPayload();
    const result = FlightSearchRequestSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.returnDate).toBeUndefined();
  });

  it("accepts a valid round-trip payload", () => {
    const result = FlightSearchRequestSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it("normalises lowercase airport codes to uppercase", () => {
    const payload = { ...validPayload(), departureAirport: "jfk", arrivalAirport: "lax" };
    const result = FlightSearchRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.departureAirport).toBe("JFK");
      expect(result.data.arrivalAirport).toBe("LAX");
    }
  });

  it("rejects a 4-letter airport code with the exact BR-11 message and field path", () => {
    const payload = { ...validPayload(), departureAirport: "KJFK" };
    const result = FlightSearchRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "departureAirport");
      expect(issue?.message).toBe(IATA_CODE_MESSAGE);
    }
  });

  it("rejects a departure date that is not in the future", () => {
    const payload = { ...validPayload(), departureDate: new Date(Date.now() - 1000).toISOString() };
    const result = FlightSearchRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "departureDate");
      expect(issue?.message).toBe(FUTURE_DEPARTURE_DATE_MESSAGE);
    }
  });

  it("rejects a return date before the departure date", () => {
    const payload = validPayload();
    const result = FlightSearchRequestSchema.safeParse({
      ...payload,
      returnDate: future(1 * 24 * 60 * 60 * 1000),
      departureDate: future(30 * 24 * 60 * 60 * 1000),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "returnDate");
      expect(issue?.message).toBe(RETURN_DATE_NOT_BEFORE_DEPARTURE_MESSAGE);
    }
  });

  it("accepts a return date equal to the departure date", () => {
    const departureDate = future(30 * 24 * 60 * 60 * 1000);
    const result = FlightSearchRequestSchema.safeParse({ ...validPayload(), departureDate, returnDate: departureDate });
    expect(result.success).toBe(true);
  });

  it("rejects 0 passengers", () => {
    const result = FlightSearchRequestSchema.safeParse({ ...validPayload(), passengers: 0 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(PASSENGER_COUNT_MESSAGE);
  });

  it("rejects 10 passengers", () => {
    const result = FlightSearchRequestSchema.safeParse({ ...validPayload(), passengers: 10 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(PASSENGER_COUNT_MESSAGE);
  });

  it("rejects a non-integer passenger count", () => {
    const result = FlightSearchRequestSchema.safeParse({ ...validPayload(), passengers: 2.5 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(PASSENGER_COUNT_MESSAGE);
  });

  it("rejects an invalid cabin class", () => {
    const result = FlightSearchRequestSchema.safeParse({ ...validPayload(), seatClass: "SUPERSONIC" });
    expect(result.success).toBe(false);
  });

  it("strips no keys but rejects unknown extra keys", () => {
    const result = FlightSearchRequestSchema.safeParse({ ...validPayload(), extraField: "unexpected" });
    expect(result.success).toBe(false);
  });
});
