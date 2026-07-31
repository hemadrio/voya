import { describe, expect, it, vi } from "vitest";
import { writeAudit } from "../../src/domain/AuditWriter.js";
import type { AuditTxClient } from "../../src/domain/AuditWriter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockTx(createFn = vi.fn().mockResolvedValue(undefined)): AuditTxClient {
  return {
    bookingAuditLog: { create: createFn },
  };
}

const BASE_PARAMS = {
  bookingId: "bk_01",
  action: "BOOKING_CREATED",
  actorId: "usr_abc",
  actorRole: "traveler",
  resourceType: "Booking",
  resourceId: "bk_01",
  occurredAt: new Date("2024-01-15T10:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeAudit", () => {
  it("calls tx.bookingAuditLog.create with the sanitised payload", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    const tx = makeMockTx(createFn);

    await writeAudit({ tx, ...BASE_PARAMS, payload: { action: "BOOKING_CREATED", amount: 199 } });

    expect(createFn).toHaveBeenCalledOnce();
    const [{ data }] = createFn.mock.calls[0] as [{ data: Record<string, unknown> }][];
    expect(data.bookingId).toBe("bk_01");
    expect(data.action).toBe("BOOKING_CREATED");
    expect(data.payload).toEqual({ action: "BOOKING_CREATED", amount: 199 });
  });

  it("redacts PII keys from the payload before persisting", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    const tx = makeMockTx(createFn);

    await writeAudit({
      tx,
      ...BASE_PARAMS,
      payload: {
        email: "passenger@example.com",
        passportNumber: "AB1234567",
        amount: 350,
        nested: { token: "tok_secret", price: 100 },
      },
    });

    const [{ data }] = createFn.mock.calls[0] as [{ data: Record<string, unknown> }][];
    const payload = data.payload as Record<string, unknown>;
    expect(payload["email"]).toBe("[REDACTED]");
    expect(payload["passportNumber"]).toBe("[REDACTED]");
    expect(payload["amount"]).toBe(350);
    const nested = payload["nested"] as Record<string, unknown>;
    expect(nested["token"]).toBe("[REDACTED]");
    expect(nested["price"]).toBe(100);
  });

  it("redacts Authorization and stripe-signature headers", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    const tx = makeMockTx(createFn);

    await writeAudit({
      tx,
      ...BASE_PARAMS,
      payload: {
        headers: { Authorization: "Bearer tok", "stripe-signature": "t=1,v1=abc" },
        body: { amount: 99 },
      },
    });

    const [{ data }] = createFn.mock.calls[0] as [{ data: Record<string, unknown> }][];
    const payload = data.payload as Record<string, unknown>;
    const headers = payload["headers"] as Record<string, unknown>;
    expect(headers["Authorization"]).toBe("[REDACTED]");
    expect(headers["stripe-signature"]).toBe("[REDACTED]");
  });

  it("returns the SanitisedPayload branded value", async () => {
    const tx = makeMockTx();
    const result = await writeAudit({ tx, ...BASE_PARAMS, payload: { amount: 10 } });
    expect(result).toEqual({ amount: 10 });
  });

  it("propagates db errors without swallowing them", async () => {
    const dbError = new Error("DB connection lost");
    const tx = makeMockTx(vi.fn().mockRejectedValue(dbError));
    await expect(writeAudit({ tx, ...BASE_PARAMS, payload: {} })).rejects.toThrow("DB connection lost");
  });

  it("handles arrays in the payload (passengers list)", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    const tx = makeMockTx(createFn);

    await writeAudit({
      tx,
      ...BASE_PARAMS,
      payload: {
        passengers: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", dateOfBirth: "1990-05-01" },
        ],
      },
    });

    const [{ data }] = createFn.mock.calls[0] as [{ data: Record<string, unknown> }][];
    const payload = data.payload as Record<string, unknown>;
    const passengers = payload["passengers"] as Record<string, unknown>[];
    expect(passengers[0]?.["email"]).toBe("[REDACTED]");
    expect(passengers[0]?.["name"]).toBe("Alice");
    expect(passengers[1]?.["dateOfBirth"]).toBe("[REDACTED]");
    expect(passengers[1]?.["name"]).toBe("Bob");
  });

  it("passes null and primitive payloads through unchanged", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    const tx = makeMockTx(createFn);

    await writeAudit({ tx, ...BASE_PARAMS, payload: null });

    const [{ data }] = createFn.mock.calls[0] as [{ data: Record<string, unknown> }][];
    expect(data.payload).toBeNull();
  });
});
