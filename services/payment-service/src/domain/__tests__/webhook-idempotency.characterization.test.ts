/**
 * Characterization tests: webhook exactly-once idempotency.
 *
 * Proves that exactly-once delivery holds in two configurations:
 *   1. Healthy Redis (SET NX with 72-hour TTL) — fast path
 *   2. Redis unavailable (throws on every call) — durable path
 *
 * In both configurations, the processed_event unique-constraint violation
 * (simulated by a fake repository) is the durable authority that prevents
 * a second booking transition and a second notification.
 *
 * Stripe delivers the same event three times in rapid succession — exactly
 * one booking transition and one notification must result.
 *
 * All collaborators are injected fakes. No Stripe API, no Redis, no DB.
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Domain type definitions used by the idempotency harness
// ---------------------------------------------------------------------------

export interface IdempotencyStore {
  /**
   * Attempt to claim the event. Returns true if this is the first delivery,
   * false if a prior delivery already claimed it (SET NX semantics).
   * Throws if the store is unavailable.
   */
  tryAcquire(eventId: string): Promise<boolean>;
}

export interface ProcessedEventRepository {
  /**
   * Persist the event as processed. Throws a UniqueConstraintError when the
   * eventId has already been inserted (unique constraint violation).
   */
  markProcessed(eventId: string, provider: string): Promise<void>;
}

export class UniqueConstraintError extends Error {
  readonly code = "UNIQUE_CONSTRAINT_VIOLATION";
  constructor(field: string) {
    super(`Unique constraint violation on ${field}`);
    this.name = "UniqueConstraintError";
  }
}

export interface BookingTransitionPort {
  /** Transition the booking to CONFIRMED. Returns the new booking status. */
  confirm(bookingId: string, eventId: string): Promise<{ status: string }>;
}

export interface NotificationPort {
  /** Enqueue a confirmation notification. */
  sendConfirmation(bookingId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Idempotent webhook handler — the system under test
// ---------------------------------------------------------------------------

export interface HandleWebhookParams {
  eventId: string;
  bookingId: string;
  provider: string;
  idempotencyStore: IdempotencyStore;
  processedEvents: ProcessedEventRepository;
  bookingTransition: BookingTransitionPort;
  notification: NotificationPort;
}

/**
 * Idempotent webhook handler.
 *
 * Layer 1 (fast path): Redis SET NX — avoids DB write on duplicate delivery.
 * Layer 2 (durable authority): processed_event unique constraint — survives
 *   Redis eviction, restart, or unavailability.
 *
 * The Redis layer is an optimisation; the DB layer is the guarantee.
 */
export async function handleWebhookIdempotent(params: HandleWebhookParams): Promise<"PROCESSED" | "DUPLICATE"> {
  const { eventId, bookingId, provider, idempotencyStore, processedEvents, bookingTransition, notification } = params;

  // Layer 1: fast dedup via Redis SET NX
  let redisAvailable = true;
  try {
    const acquired = await idempotencyStore.tryAcquire(eventId);
    if (!acquired) {
      // Redis says this is a duplicate — skip without DB write
      return "DUPLICATE";
    }
  } catch {
    // Redis unavailable — fall through to durable DB layer
    redisAvailable = false;
  }

  // Layer 2: durable dedup via processed_event unique constraint
  try {
    await processedEvents.markProcessed(eventId, provider);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      // DB constraint says this is a duplicate — stop here
      return "DUPLICATE";
    }
    throw err;
  }

  // Exactly one transition and one notification
  await bookingTransition.confirm(bookingId, eventId);
  await notification.sendConfirmation(bookingId);

  return "PROCESSED";
}

// ---------------------------------------------------------------------------
// Fake builders
// ---------------------------------------------------------------------------

function makeHealthyRedis(): { store: IdempotencyStore; acquiredKeys: Set<string> } {
  const acquiredKeys = new Set<string>();
  return {
    acquiredKeys,
    store: {
      async tryAcquire(eventId) {
        if (acquiredKeys.has(eventId)) return false;
        acquiredKeys.add(eventId);
        return true;
      },
    },
  };
}

function makeUnavailableRedis(): IdempotencyStore {
  return {
    async tryAcquire(_eventId) {
      throw new Error("Redis ECONNREFUSED");
    },
  };
}

function makeProcessedEventRepository(): {
  repo: ProcessedEventRepository;
  processed: Set<string>;
} {
  const processed = new Set<string>();
  return {
    processed,
    repo: {
      async markProcessed(eventId) {
        if (processed.has(eventId)) {
          throw new UniqueConstraintError("processed_event.eventId");
        }
        processed.add(eventId);
      },
    },
  };
}

function makeBookingTransition(): {
  port: BookingTransitionPort;
  transitionCalls: string[];
} {
  const transitionCalls: string[] = [];
  return {
    transitionCalls,
    port: {
      async confirm(bookingId) {
        transitionCalls.push(bookingId);
        return { status: "CONFIRMED" };
      },
    },
  };
}

function makeNotification(): {
  port: NotificationPort;
  notificationCalls: string[];
} {
  const notificationCalls: string[] = [];
  return {
    notificationCalls,
    port: {
      async sendConfirmation(bookingId) {
        notificationCalls.push(bookingId);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Happy path — healthy Redis
// ---------------------------------------------------------------------------

describe("Webhook idempotency — healthy Redis (SET NX fast path)", () => {
  it("processes first delivery and returns PROCESSED", async () => {
    const { store } = makeHealthyRedis();
    const { repo } = makeProcessedEventRepository();
    const { port: booking, transitionCalls } = makeBookingTransition();
    const { port: notify, notificationCalls } = makeNotification();

    const result = await handleWebhookIdempotent({
      eventId: "SYNTH-EVT-0001",
      bookingId: "f0000002-0000-4000-8000-000000000001",
      provider: "stripe",
      idempotencyStore: store,
      processedEvents: repo,
      bookingTransition: booking,
      notification: notify,
    });

    expect(result).toBe("PROCESSED");
    expect(transitionCalls).toHaveLength(1);
    expect(notificationCalls).toHaveLength(1);
  });

  it("returns DUPLICATE and makes no transition on second delivery", async () => {
    const { store } = makeHealthyRedis();
    const { repo } = makeProcessedEventRepository();
    const { port: booking, transitionCalls } = makeBookingTransition();
    const { port: notify, notificationCalls } = makeNotification();

    const params = {
      eventId: "SYNTH-EVT-0001",
      bookingId: "f0000002-0000-4000-8000-000000000001",
      provider: "stripe",
      idempotencyStore: store,
      processedEvents: repo,
      bookingTransition: booking,
      notification: notify,
    };

    await handleWebhookIdempotent(params);
    const second = await handleWebhookIdempotent(params);

    expect(second).toBe("DUPLICATE");
    expect(transitionCalls).toHaveLength(1); // only once
    expect(notificationCalls).toHaveLength(1); // only once
  });

  it("three rapid deliveries result in exactly one transition and one notification", async () => {
    const { store } = makeHealthyRedis();
    const { repo } = makeProcessedEventRepository();
    const { port: booking, transitionCalls } = makeBookingTransition();
    const { port: notify, notificationCalls } = makeNotification();

    const params = {
      eventId: "SYNTH-EVT-0001",
      bookingId: "f0000002-0000-4000-8000-000000000001",
      provider: "stripe",
      idempotencyStore: store,
      processedEvents: repo,
      bookingTransition: booking,
      notification: notify,
    };

    const results = await Promise.all([
      handleWebhookIdempotent(params),
      handleWebhookIdempotent(params),
      handleWebhookIdempotent(params),
    ]);

    const processed = results.filter((r) => r === "PROCESSED");
    const duplicates = results.filter((r) => r === "DUPLICATE");
    expect(processed).toHaveLength(1);
    expect(duplicates).toHaveLength(2);
    expect(transitionCalls).toHaveLength(1);
    expect(notificationCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Redis unavailable — durable DB constraint is the authority
// ---------------------------------------------------------------------------

describe("Webhook idempotency — Redis unavailable (durable path)", () => {
  it("falls through to DB constraint when Redis throws", async () => {
    const redisDown = makeUnavailableRedis();
    const { repo } = makeProcessedEventRepository();
    const { port: booking, transitionCalls } = makeBookingTransition();
    const { port: notify, notificationCalls } = makeNotification();

    const result = await handleWebhookIdempotent({
      eventId: "SYNTH-EVT-0002",
      bookingId: "f0000002-0000-4000-8000-000000000002",
      provider: "stripe",
      idempotencyStore: redisDown,
      processedEvents: repo,
      bookingTransition: booking,
      notification: notify,
    });

    expect(result).toBe("PROCESSED");
    expect(transitionCalls).toHaveLength(1);
    expect(notificationCalls).toHaveLength(1);
  });

  it("second delivery with Redis unavailable is blocked by DB unique constraint", async () => {
    const redisDown = makeUnavailableRedis();
    const { repo } = makeProcessedEventRepository();
    const { port: booking, transitionCalls } = makeBookingTransition();
    const { port: notify, notificationCalls } = makeNotification();

    const params = {
      eventId: "SYNTH-EVT-0002",
      bookingId: "f0000002-0000-4000-8000-000000000002",
      provider: "stripe",
      idempotencyStore: redisDown,
      processedEvents: repo,
      bookingTransition: booking,
      notification: notify,
    };

    await handleWebhookIdempotent(params);
    const second = await handleWebhookIdempotent(params);

    expect(second).toBe("DUPLICATE");
    expect(transitionCalls).toHaveLength(1);
    expect(notificationCalls).toHaveLength(1);
  });

  it("three deliveries with Redis unavailable yield one transition via DB constraint", async () => {
    const redisDown = makeUnavailableRedis();
    const { repo } = makeProcessedEventRepository();
    const { port: booking, transitionCalls } = makeBookingTransition();
    const { port: notify, notificationCalls } = makeNotification();

    const params = {
      eventId: "SYNTH-EVT-0003",
      bookingId: "f0000002-0000-4000-8000-000000000003",
      provider: "stripe",
      idempotencyStore: redisDown,
      processedEvents: repo,
      bookingTransition: booking,
      notification: notify,
    };

    // Sequential deliveries (simulating rapid retries)
    const r1 = await handleWebhookIdempotent(params);
    const r2 = await handleWebhookIdempotent(params);
    const r3 = await handleWebhookIdempotent(params);

    expect(r1).toBe("PROCESSED");
    expect(r2).toBe("DUPLICATE");
    expect(r3).toBe("DUPLICATE");
    expect(transitionCalls).toHaveLength(1);
    expect(notificationCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Booking for already-cancelled booking must be rejected by lifecycle guard
// ---------------------------------------------------------------------------

describe("Webhook idempotency — lifecycle conflict on cancelled booking", () => {
  it("transition call returns lifecycle conflict for cancelled booking", async () => {
    const { store } = makeHealthyRedis();
    const { repo } = makeProcessedEventRepository();
    const { port: notify } = makeNotification();

    // Simulate transition port that throws lifecycle conflict
    const bookingTransitionConflict: BookingTransitionPort = {
      async confirm(_bookingId) {
        const err = new Error("Cannot transition booking from CANCELLED to CONFIRMED");
        (err as unknown as Record<string, unknown>)["code"] = "LIFECYCLE_CONFLICT";
        throw err;
      },
    };

    await expect(
      handleWebhookIdempotent({
        eventId: "SYNTH-EVT-CANCELLED",
        bookingId: "f0000002-0000-4000-8000-000000000006",
        provider: "stripe",
        idempotencyStore: store,
        processedEvents: repo,
        bookingTransition: bookingTransitionConflict,
        notification: notify,
      }),
    ).rejects.toThrow(/CANCELLED.*CONFIRMED|CONFIRMED.*CANCELLED|Cannot transition/);
  });
});
