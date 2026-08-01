/**
 * Unit tests for FunnelEmitter (WO-106 AC2, AC3, AC9, AC10).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FunnelEmitter,
} from "../../src/funnel/funnelEmitter.js";
import type {
  FunnelStorePort,
  FunnelEmfWriterPort,
} from "../../src/funnel/funnelEmitter.js";
import type { FunnelEvent } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<FunnelEvent> = {}): FunnelEvent {
  return {
    schemaVersion: 1,
    eventType: "search_performed",
    occurredAt: "2026-01-15T12:00:00.000Z",
    correlationId: "corr-test",
    pseudonymousActorId: "a".repeat(64),
    sessionId: "sess-test",
    category: "FLIGHT",
    attributes: {},
    ...overrides,
  };
}

function makeStore(): FunnelStorePort & { calls: FunnelEvent[][] } {
  const calls: FunnelEvent[][] = [];
  return {
    calls,
    async insertBatch(events) { calls.push([...events]); },
  };
}

function makeEmfWriter(): FunnelEmfWriterPort & { calls: FunnelEvent[][] } {
  const calls: FunnelEvent[][] = [];
  return {
    calls,
    writeBatch(events) { calls.push([...events]); },
  };
}

function makeEmitter(
  store: FunnelStorePort,
  emf: FunnelEmfWriterPort,
  opts: { maxBufferSize?: number } = {},
) {
  return new FunnelEmitter(store, emf, {
    flushIntervalMs: 100_000, // disable automatic flush in tests
    heartbeatIntervalMs: 100_000,
    maxBufferSize: opts.maxBufferSize ?? 10,
  });
}

// ---------------------------------------------------------------------------
// AC2: emit() returns immediately
// ---------------------------------------------------------------------------

describe("FunnelEmitter.emit — non-blocking", () => {
  it("emit() returns synchronously (does not return a Promise)", () => {
    const emitter = makeEmitter(makeStore(), makeEmfWriter());
    const result = emitter.emit(makeEvent());
    expect(result).toBeUndefined(); // void, not a Promise
    emitter.destroy();
  });

  it("bufferSize increments after each emit", () => {
    const emitter = makeEmitter(makeStore(), makeEmfWriter());
    emitter.emit(makeEvent());
    emitter.emit(makeEvent({ eventType: "results_viewed" }));
    expect(emitter.bufferSize).toBe(2);
    emitter.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC3: flush sends events to store and EMF writer
// ---------------------------------------------------------------------------

describe("FunnelEmitter.flush — persistence", () => {
  it("flush() persists buffered events to the store", async () => {
    const store = makeStore();
    const emitter = makeEmitter(store, makeEmfWriter());

    emitter.emit(makeEvent({ eventType: "search_performed" }));
    emitter.emit(makeEvent({ eventType: "booking_created" }));
    await emitter.flush();

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toHaveLength(2);
    emitter.destroy();
  });

  it("flush() calls the EMF writer with the batch", async () => {
    const emf = makeEmfWriter();
    const emitter = makeEmitter(makeStore(), emf);

    emitter.emit(makeEvent());
    await emitter.flush();

    expect(emf.calls).toHaveLength(1);
    expect(emf.calls[0]).toHaveLength(1);
    emitter.destroy();
  });

  it("flush() clears the buffer", async () => {
    const emitter = makeEmitter(makeStore(), makeEmfWriter());
    emitter.emit(makeEvent());
    expect(emitter.bufferSize).toBe(1);
    await emitter.flush();
    expect(emitter.bufferSize).toBe(0);
    emitter.destroy();
  });

  it("flush() is idempotent on an empty buffer", async () => {
    const store = makeStore();
    const emitter = makeEmitter(store, makeEmfWriter());
    await emitter.flush();
    await emitter.flush();
    expect(store.calls).toHaveLength(0);
    emitter.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC3: bounded-buffer drop-oldest
// ---------------------------------------------------------------------------

describe("FunnelEmitter — bounded buffer drop-oldest", () => {
  it("drops the oldest event when the buffer is full", () => {
    const emitter = makeEmitter(makeStore(), makeEmfWriter(), { maxBufferSize: 3 });

    emitter.emit(makeEvent({ eventType: "session_started" }));
    emitter.emit(makeEvent({ eventType: "search_performed" }));
    emitter.emit(makeEvent({ eventType: "results_viewed" }));
    // Buffer is now full (maxBufferSize = 3)
    emitter.emit(makeEvent({ eventType: "offer_selected" }));

    expect(emitter.bufferSize).toBe(3);
    expect(emitter.droppedEventsCount).toBe(1);
    emitter.destroy();
  });
});

// ---------------------------------------------------------------------------
// Store failure does not propagate to the caller
// ---------------------------------------------------------------------------

describe("FunnelEmitter — store failure isolation", () => {
  it("a throwing store does not cause flush() to reject", async () => {
    const throwingStore: FunnelStorePort = {
      async insertBatch() {
        throw new Error("RDS connection refused");
      },
    };
    const emitter = makeEmitter(throwingStore, makeEmfWriter());
    emitter.emit(makeEvent());

    // flush() must not throw
    await expect(emitter.flush()).resolves.toBeUndefined();
    expect(emitter.emissionFailuresCount).toBe(1);
    emitter.destroy();
  });

  it("events are re-queued after a store failure", async () => {
    const failOnce = { count: 0 };
    const store: FunnelStorePort = {
      async insertBatch(events) {
        if (failOnce.count++ === 0) throw new Error("transient failure");
        // Second call succeeds
      },
    };
    const emitter = makeEmitter(store, makeEmfWriter(), { maxBufferSize: 50 });
    emitter.emit(makeEvent({ eventType: "search_performed" }));

    await emitter.flush(); // fails, re-queues
    expect(emitter.bufferSize).toBe(1); // re-queued

    await emitter.flush(); // succeeds
    expect(emitter.bufferSize).toBe(0);
    emitter.destroy();
  });
});

// ---------------------------------------------------------------------------
// Schema validation — invalid events dropped at emit time
// ---------------------------------------------------------------------------

describe("FunnelEmitter — schema validation", () => {
  it("drops and counts a malformed event (PII field present)", () => {
    const emitter = makeEmitter(makeStore(), makeEmfWriter());
    const malformed = {
      ...makeEvent(),
      email: "user@example.com", // PII field — fails strict schema
    } as unknown as FunnelEvent;

    emitter.emit(malformed);
    expect(emitter.validationFailuresCount).toBe(1);
    expect(emitter.bufferSize).toBe(0);
    emitter.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC9: heartbeat counter (structural test)
// ---------------------------------------------------------------------------

describe("FunnelEmitter — heartbeat", () => {
  it("emitter can be constructed and destroyed without error", () => {
    const emitter = makeEmitter(makeStore(), makeEmfWriter());
    expect(emitter).toBeTruthy();
    emitter.destroy();
  });
});
