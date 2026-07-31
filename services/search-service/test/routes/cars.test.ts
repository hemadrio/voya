/**
 * Car rental search route — validation boundary tests.
 *
 * AC5: Drop-off before pickup is rejected at the service boundary with a
 *      structured 400 identifying the invalid field (US-003).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { SearchAdapter } from "../../src/adapters/SearchAdapter.js";
import { DROPOFF_AFTER_PICKUP_MESSAGE, FUTURE_PICKUP_DATE_MESSAGE } from "@travel/contracts";

function makeStubAdapter(): SearchAdapter {
  return {
    searchFlights: vi.fn(async () => []) as unknown as SearchAdapter["searchFlights"],
    searchHotels: vi.fn(async () => []) as unknown as SearchAdapter["searchHotels"],
    searchCars: vi.fn(async () => []) as unknown as SearchAdapter["searchCars"],
  };
}

const VALID_CAR_BODY = {
  pickupLocation: "LAX Airport",
  dropoffLocation: "LAX Airport",
  pickupDate: "2030-06-01T09:00:00.000Z",
  dropoffDate: "2030-06-05T09:00:00.000Z",
  carClass: "MIDSIZE",
  currency: "USD",
};

describe("POST /search/cars — validation boundary", () => {
  let adapter: ReturnType<typeof makeStubAdapter>;

  beforeEach(() => {
    adapter = makeStubAdapter();
  });

  // ── AC5: US-003 drop-off before pickup ──────────────────────────────────

  it("AC5 — rejects drop-off equal to pickup (US-003)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/cars")
      .send({ ...VALID_CAR_BODY, dropoffDate: VALID_CAR_BODY.pickupDate });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.message).toBe(DROPOFF_AFTER_PICKUP_MESSAGE);
    expect(res.body.error.field).toBe("dropoffDate");

    // AC5: adapter was NEVER called
    expect(adapter.searchCars).not.toHaveBeenCalled();
  });

  it("AC5 — rejects drop-off before pickup (US-003)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/cars")
      .send({ ...VALID_CAR_BODY, dropoffDate: "2030-05-31T09:00:00.000Z" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(DROPOFF_AFTER_PICKUP_MESSAGE);
    expect(res.body.error.field).toBe("dropoffDate");
    expect(adapter.searchCars).not.toHaveBeenCalled();
  });

  it("rejects past pickup date with future-date message", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/cars")
      .send({ ...VALID_CAR_BODY, pickupDate: "2020-01-01T00:00:00.000Z", dropoffDate: "2020-01-05T00:00:00.000Z" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(FUTURE_PICKUP_DATE_MESSAGE);
    expect(adapter.searchCars).not.toHaveBeenCalled();
  });

  it("rejects unknown keys (strict schema)", async () => {
    const app = createApp(adapter);
    const res = await request(app)
      .post("/search/cars")
      .send({ ...VALID_CAR_BODY, constructor: {} });

    expect(res.status).toBe(400);
    expect(adapter.searchCars).not.toHaveBeenCalled();
  });

  it("valid payload calls adapter and returns 200", async () => {
    const app = createApp(adapter);
    const res = await request(app).post("/search/cars").send(VALID_CAR_BODY);

    expect(res.status).toBe(200);
    expect(adapter.searchCars).toHaveBeenCalledOnce();
  });
});
