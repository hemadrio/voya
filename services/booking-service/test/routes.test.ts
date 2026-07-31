/**
 * booking-service validation boundary tests.
 *
 * AC6/AC12: Valid and invalid payloads; idempotency-key header validation;
 *           bookingId param validation.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { BookingDomain } from "../src/routes/bookings.js";

function makeDomain(): BookingDomain {
  return {
    create: vi.fn(async () => ({ id: "booking-1", status: "PENDING" })),
    getById: vi.fn(async () => ({ id: "booking-1", status: "PENDING" })),
    cancel: vi.fn(async () => ({ id: "booking-1", status: "CANCELLED" })),
  };
}

const VALID_BOOKING_BODY = {
  bookingType: "FLIGHT",
  offerId: "offer-abc",
  offerPrice: 499.99,
  currency: "USD",
  passengers: [
    {
      firstName: "Alice",
      lastName: "Smith",
      dateOfBirth: "1990-01-15T00:00:00.000Z",
      passportNumber: "A12345678",
    },
  ],
  contactEmail: "alice@example.com",
  idempotencyKey: "idem-key-001",
};

describe("POST /bookings — body and header validation", () => {
  it("rejects missing Idempotency-Key header with 400", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/bookings").send(VALID_BOOKING_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(domain.create).not.toHaveBeenCalled();
  });

  it("rejects invalid booking body with 400", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/bookings")
      .set("idempotency-key", "idem-001")
      .send({ bookingType: "FLIGHT" }); // missing required fields

    expect(res.status).toBe(400);
    expect(domain.create).not.toHaveBeenCalled();
  });

  it("rejects empty passengers array with 400", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/bookings")
      .set("idempotency-key", "idem-001")
      .send({ ...VALID_BOOKING_BODY, passengers: [] });

    expect(res.status).toBe(400);
    expect(domain.create).not.toHaveBeenCalled();
  });

  it("valid payload with header calls domain", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/bookings")
      .set("idempotency-key", "idem-001")
      .send(VALID_BOOKING_BODY);

    expect(res.status).toBe(201);
    expect(domain.create).toHaveBeenCalledOnce();
  });
});

describe("GET /bookings/:bookingId — param validation", () => {
  it("valid bookingId calls domain", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).get("/bookings/booking-xyz");

    expect(res.status).toBe(200);
    expect(domain.getById).toHaveBeenCalledWith("booking-xyz");
  });
});

describe("POST /bookings/:bookingId/cancel", () => {
  it("valid bookingId calls domain cancel", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/bookings/booking-xyz/cancel");

    expect(res.status).toBe(200);
    expect(domain.cancel).toHaveBeenCalledWith("booking-xyz");
  });
});
