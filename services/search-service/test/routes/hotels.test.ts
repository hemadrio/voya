/**
 * Hotel search route — validation boundary tests.
 *
 * AC4: Check-out on or before check-in fails with a field-level message
 *      naming checkOutDate and no supplier call is made (US-002).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { SearchAdapter } from "../../src/adapters/SearchAdapter.js";
import { CHECK_OUT_AFTER_CHECK_IN_MESSAGE } from "@travel/contracts";

function makeStubAdapter(): SearchAdapter {
  return {
    searchFlights: vi.fn(async () => []) as unknown as SearchAdapter["searchFlights"],
    searchHotels: vi.fn(async () => []) as unknown as SearchAdapter["searchHotels"],
    searchCars: vi.fn(async () => []) as unknown as SearchAdapter["searchCars"],
  };
}

const VALID_HOTEL_BODY = {
  location: "Paris, France",
  checkInDate: "2030-06-01T00:00:00.000Z",
  checkOutDate: "2030-06-05T00:00:00.000Z",
  guests: 2,
  currency: "EUR",
};

describe("POST /search/hotels — validation boundary", () => {
  let adapter: ReturnType<typeof makeStubAdapter>;

  beforeEach(() => {
    adapter = makeStubAdapter();
  });

  // ── AC4: US-002 checkout before check-in ────────────────────────────────

  it("AC4 — rejects check-out equal to check-in (US-002)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/hotels")
      .send({ ...VALID_HOTEL_BODY, checkOutDate: VALID_HOTEL_BODY.checkInDate });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.message).toBe(CHECK_OUT_AFTER_CHECK_IN_MESSAGE);
    expect(res.body.error.field).toBe("checkOutDate");

    // AC4: adapter was NEVER called
    expect(adapter.searchHotels).not.toHaveBeenCalled();
  });

  it("AC4 — rejects check-out before check-in (US-002)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/hotels")
      .send({ ...VALID_HOTEL_BODY, checkOutDate: "2030-05-30T00:00:00.000Z" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(CHECK_OUT_AFTER_CHECK_IN_MESSAGE);
    expect(res.body.error.field).toBe("checkOutDate");
    expect(adapter.searchHotels).not.toHaveBeenCalled();
  });

  it("rejects empty location with 400", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/hotels")
      .send({ ...VALID_HOTEL_BODY, location: "" });

    expect(res.status).toBe(400);
    expect(adapter.searchHotels).not.toHaveBeenCalled();
  });

  it("rejects unknown keys (strict schema)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/hotels")
      .send({ ...VALID_HOTEL_BODY, __proto__: {} });

    expect(res.status).toBe(400);
    expect(adapter.searchHotels).not.toHaveBeenCalled();
  });

  it("valid payload calls adapter and returns 200", async () => {
    const app = createApp(adapter);
    const res = await request(app).post("/search/hotels").send(VALID_HOTEL_BODY);

    expect(res.status).toBe(200);
    expect(adapter.searchHotels).toHaveBeenCalledOnce();
  });
});
