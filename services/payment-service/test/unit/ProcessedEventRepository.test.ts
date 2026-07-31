import { describe, expect, it, vi } from "vitest";
import {
  recordProcessedEvent,
} from "../../src/repositories/ProcessedEventRepository.js";
import type { ProcessedEventDbClient } from "../../src/repositories/ProcessedEventRepository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(createFn = vi.fn().mockResolvedValue(undefined)): ProcessedEventDbClient {
  return { processedEvent: { create: createFn } };
}

const FIXTURE_DATA = {
  provider: "stripe",
  eventId: "evt_1OaBcDEfGhIjKlMn",
  receivedAt: new Date("2024-01-15T12:00:00Z"),
};

// Simulates Prisma wrapping of a PostgreSQL unique_violation (23505).
function uniqueViolationError(): Error {
  const err = new Error("Unique constraint failed on the constraint: `uq_processed_events_provider_event`");
  (err as unknown as Record<string, unknown>)["code"] = "23505";
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recordProcessedEvent", () => {
  it("returns 'inserted' on successful first insert", async () => {
    const db = makeDb();
    const result = await recordProcessedEvent(db, FIXTURE_DATA);
    expect(result).toBe("inserted");
  });

  it("passes provider, eventId, and receivedAt to db.processedEvent.create", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    const db = makeDb(createFn);
    await recordProcessedEvent(db, FIXTURE_DATA);
    expect(createFn).toHaveBeenCalledOnce();
    expect(createFn).toHaveBeenCalledWith({
      data: {
        provider: "stripe",
        eventId: "evt_1OaBcDEfGhIjKlMn",
        receivedAt: FIXTURE_DATA.receivedAt,
      },
    });
  });

  it("returns 'duplicate' when the unique constraint fires (PG error 23505)", async () => {
    const createFn = vi.fn().mockRejectedValue(uniqueViolationError());
    const db = makeDb(createFn);
    const result = await recordProcessedEvent(db, FIXTURE_DATA);
    expect(result).toBe("duplicate");
  });

  it("re-throws unrelated database errors", async () => {
    const connectionError = new Error("Connection refused");
    const createFn = vi.fn().mockRejectedValue(connectionError);
    const db = makeDb(createFn);
    await expect(recordProcessedEvent(db, FIXTURE_DATA)).rejects.toThrow("Connection refused");
  });

  it("re-throws errors with no .code property", async () => {
    const genericError = new Error("Unknown error");
    const createFn = vi.fn().mockRejectedValue(genericError);
    const db = makeDb(createFn);
    await expect(recordProcessedEvent(db, FIXTURE_DATA)).rejects.toThrow("Unknown error");
  });

  it("re-throws errors with a non-23505 code", async () => {
    const foreignKeyError = new Error("Foreign key constraint failed");
    (foreignKeyError as unknown as Record<string, unknown>)["code"] = "23503";
    const createFn = vi.fn().mockRejectedValue(foreignKeyError);
    const db = makeDb(createFn);
    await expect(recordProcessedEvent(db, FIXTURE_DATA)).rejects.toThrow("Foreign key constraint failed");
  });

  it("handles a second provider's event_id that matches another provider", async () => {
    // Different provider — same event_id — should NOT be a duplicate
    const createFn = vi.fn().mockResolvedValue(undefined);
    const db = makeDb(createFn);
    const result = await recordProcessedEvent(db, {
      provider: "adyen",
      eventId: "evt_1OaBcDEfGhIjKlMn",
      receivedAt: new Date(),
    });
    expect(result).toBe("inserted");
  });
});
