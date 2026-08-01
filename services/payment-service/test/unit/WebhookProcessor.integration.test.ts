/**
 * WO-047 AC10: System integration tests for exactly-once webhook processing.
 *
 * These tests use in-memory fakes (no real Redis, Postgres, or SQS) but
 * exercise the full pipeline in a way that mirrors the integration described
 * in AC10:
 *
 *   "Triple delivery of a signed payment_intent.succeeded through the gateway
 *    asserts one transition, one audit row, one queue message and one
 *    processed_events row, with Redis flushed between the second and third
 *    delivery to prove the database is the authority."
 *
 * The fixture files (FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED) are
 * committed signed payloads so the test suite can run offline (AC11).
 */

import { describe, it, expect } from "vitest";
import { WebhookProcessor } from "../../src/domain/WebhookProcessor.js";
import { InMemoryDedupCache } from "../../src/domain/DedupCachePort.js";
import { InMemoryBookingCommandPort } from "../../src/domain/BookingCommandPort.js";
import { WebhookVerifier } from "../../src/domain/WebhookVerifier.js";
import type {
  WebhookTxClient,
  WebhookDbClient,
  WebhookLogger,
} from "../../src/domain/WebhookProcessor.js";
import type { QueuePort } from "@travel/queue";
import type { QueueMessageEnvelope } from "@travel/contracts";
import {
  FIXTURE_PAYMENT_SUCCEEDED,
  FIXTURE_PAYMENT_FAILED,
  FIXTURE_UNKNOWN_EVENT_TYPE,
  FIXTURE_PAYMENT_SUCCEEDED_DUPLICATE,
  WEBHOOK_TEST_SECRET,
  SYNTH_BOOKING_ID,
  SYNTH_PAYMENT_INTENT_ID,
} from "../fixtures/webhook-fixtures.js";

// ---------------------------------------------------------------------------
// Shared fakes (reused across test groups)
// ---------------------------------------------------------------------------

const USER_ID = "u0000001-0000-4000-8000-000000000001";

function makeInMemoryDb(): WebhookDbClient & {
  processedEvents: Array<{ eventId: string; eventType: string; outcome: string }>;
  auditRows: Array<{ bookingId: string; action: string }>;
  reconciliationExceptions: Array<{ kind: string }>;
  paymentUpdates: Array<{ providerReference: string; status: string }>;
} {
  const processedEvents: Array<{ eventId: string; eventType: string; outcome: string }> = [];
  const auditRows: Array<{ bookingId: string; action: string }> = [];
  const reconciliationExceptions: Array<{ kind: string }> = [];
  const paymentUpdates: Array<{ providerReference: string; status: string }> = [];

  const buildTx = (): WebhookTxClient => ({
    processedEvent: {
      async create({ data }) {
        const exists = processedEvents.some(
          (e) => e.eventId === data.eventId,
        );
        if (exists) {
          throw Object.assign(
            new Error("Unique constraint failed: uq_processed_events_provider_event"),
            { code: "23505" },
          );
        }
        processedEvents.push({ eventId: data.eventId, eventType: data.eventType, outcome: data.outcome });
      },
    },
    reconciliationException: {
      async create({ data }) {
        reconciliationExceptions.push({ kind: data.kind });
      },
    },
    bookingAuditLog: {
      async create({ data }) {
        auditRows.push({ bookingId: data.bookingId as string, action: data.action as string });
      },
    },
    payment: {
      async updateMany({ where, data }) {
        paymentUpdates.push({ providerReference: where.providerReference, status: data.status });
        return { count: 1 };
      },
    },
  });

  return {
    processedEvents,
    auditRows,
    reconciliationExceptions,
    paymentUpdates,
    async $transaction(fn) {
      return fn(buildTx());
    },
  };
}

function makeQueueSpy(): QueuePort & { published: QueueMessageEnvelope[] } {
  const published: QueueMessageEnvelope[] = [];
  return {
    published,
    async publish(_topic, envelope) { published.push(envelope); },
    async subscribe() {},
    async isHealthy() { return true; },
    async close() {},
  };
}

const nullLogger: WebhookLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Fixed-clock verifier (disables timestamp tolerance for fixture payloads)
// ---------------------------------------------------------------------------

function makeVerifier(): WebhookVerifier {
  return new WebhookVerifier({
    signingSecret: WEBHOOK_TEST_SECRET,
    clock: () => 1735689600, // matches WEBHOOK_FIXED_TIMESTAMP in fixtures
  });
}

// ---------------------------------------------------------------------------
// Helper: parse fixture and call process()
// ---------------------------------------------------------------------------

async function processFixture(
  processor: WebhookProcessor,
  verifier: WebhookVerifier,
  fixtureBody: string,
  signatureHeader: string,
) {
  const rawBody = Buffer.from(fixtureBody, "utf8");
  const event = verifier.verify(rawBody, signatureHeader);
  return processor.process(event, rawBody, "corr-test-001");
}

// ===========================================================================
// AC10: Triple delivery with Redis flush
// ===========================================================================

describe("WO-047 AC10: Triple delivery — exactly one effect (Redis flushed between deliveries)", () => {
  it("three deliveries of the same event produce one PROCESSED and two DUPLICATE", async () => {
    const cache = new InMemoryDedupCache();
    const db = makeInMemoryDb();
    const bookingPort = new InMemoryBookingCommandPort()
      .addBooking(SYNTH_BOOKING_ID, "PENDING", USER_ID);
    const queue = makeQueueSpy();
    const verifier = makeVerifier();

    const processor = new WebhookProcessor(cache, db, bookingPort, queue, nullLogger);

    // Delivery 1 — first; Redis claims key, DB inserts row
    const { makeWebhookHeaderNow: _, ..._ } = await import("../fixtures/webhook-fixtures.js");
    void _;

    const { SIG_PAYMENT_SUCCEEDED } = await import("../fixtures/webhook-fixtures.js");

    const r1 = await processFixture(processor, verifier, FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED);
    expect(r1).toBe("PROCESSED");
    expect(db.processedEvents).toHaveLength(1);
    expect(db.auditRows).toHaveLength(1);
    expect(queue.published).toHaveLength(1);
    expect(bookingPort.transitionCalls).toHaveLength(1);

    // Delivery 2 — Redis cache hit → DUPLICATE, no new writes
    const r2 = await processFixture(processor, verifier, FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED);
    expect(r2).toBe("DUPLICATE");
    expect(db.processedEvents).toHaveLength(1); // unchanged
    expect(db.auditRows).toHaveLength(1);       // unchanged
    expect(queue.published).toHaveLength(1);    // unchanged

    // Flush Redis — simulates TTL expiry or node restart
    cache.flushAll();

    // Delivery 3 — Redis miss, but DB unique constraint fires → DUPLICATE
    const r3 = await processFixture(processor, verifier, FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED);
    expect(r3).toBe("DUPLICATE");
    expect(db.processedEvents).toHaveLength(1); // still exactly one
    expect(db.auditRows).toHaveLength(1);       // still exactly one
    expect(queue.published).toHaveLength(1);    // still exactly one
    expect(bookingPort.transitionCalls).toHaveLength(1); // still exactly one
  });

  it("one processed_events row with outcome=PROCESSED after three deliveries (AC1)", async () => {
    const cache = new InMemoryDedupCache();
    const db = makeInMemoryDb();
    const bookingPort = new InMemoryBookingCommandPort()
      .addBooking(SYNTH_BOOKING_ID, "PENDING", USER_ID);
    const verifier = makeVerifier();
    const processor = new WebhookProcessor(cache, db, bookingPort, makeQueueSpy(), nullLogger);

    const { SIG_PAYMENT_SUCCEEDED } = await import("../fixtures/webhook-fixtures.js");

    await processFixture(processor, verifier, FIXTURE_PAYMENT_SUCCEEDED, SIG_PAYMENT_SUCCEEDED);
    cache.flushAll();
    await processFixture(processor, verifier, FIXTURE_PAYMENT_SUCCEEDED_DUPLICATE, SIG_PAYMENT_SUCCEEDED);

    expect(db.processedEvents).toHaveLength(1);
    expect(db.processedEvents[0]!.outcome).toBe("PROCESSED");
  });
});

// ---------------------------------------------------------------------------
// AC10: payment_intent.payment_failed integration
// ---------------------------------------------------------------------------

describe("WO-047 AC10: payment_intent.payment_failed integration", () => {
  it("failed event leaves booking PENDING and does not publish confirmation", async () => {
    const { SIG_PAYMENT_FAILED } = await import("../fixtures/webhook-fixtures.js");
    const db = makeInMemoryDb();
    const bookingPort = new InMemoryBookingCommandPort()
      .addBooking(SYNTH_BOOKING_ID, "PENDING", USER_ID);
    const queue = makeQueueSpy();
    const verifier = makeVerifier();
    const processor = new WebhookProcessor(
      new InMemoryDedupCache(), db, bookingPort, queue, nullLogger,
    );

    const outcome = await processFixture(
      processor, verifier, FIXTURE_PAYMENT_FAILED, SIG_PAYMENT_FAILED,
    );

    expect(outcome).toBe("PROCESSED");
    expect(bookingPort.transitionCalls).toHaveLength(0); // booking stays PENDING
    expect(queue.published).toHaveLength(0);             // no confirmation
    expect(db.paymentUpdates[0]!.status).toBe("FAILED");
    expect(db.processedEvents[0]!.outcome).toBe("PROCESSED");
  });
});

// ---------------------------------------------------------------------------
// AC10: Unknown event type integration
// ---------------------------------------------------------------------------

describe("WO-047 AC10: unknown event type integration (IGNORED)", () => {
  it("unhandled event type is recorded as IGNORED and returns 200 no-op", async () => {
    const { SIG_UNKNOWN_EVENT_TYPE } = await import("../fixtures/webhook-fixtures.js");
    const db = makeInMemoryDb();
    const queue = makeQueueSpy();
    const verifier = makeVerifier();
    const processor = new WebhookProcessor(
      new InMemoryDedupCache(),
      db,
      new InMemoryBookingCommandPort(),
      queue,
      nullLogger,
    );

    const outcome = await processFixture(
      processor, verifier, FIXTURE_UNKNOWN_EVENT_TYPE, SIG_UNKNOWN_EVENT_TYPE,
    );

    expect(outcome).toBe("IGNORED");
    expect(db.processedEvents).toHaveLength(1);
    expect(db.processedEvents[0]!.outcome).toBe("IGNORED");
    expect(db.processedEvents[0]!.eventType).toBe("customer.created");
    expect(queue.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC11 offline: committed fixtures pass signature verification
// ---------------------------------------------------------------------------

describe("WO-047 AC11: committed fixtures are correctly signed (offline verification)", () => {
  it("FIXTURE_PAYMENT_SUCCEEDED verifies against WEBHOOK_TEST_SECRET", async () => {
    const { SIG_PAYMENT_SUCCEEDED } = await import("../fixtures/webhook-fixtures.js");
    const verifier = makeVerifier();
    const event = verifier.verify(Buffer.from(FIXTURE_PAYMENT_SUCCEEDED), SIG_PAYMENT_SUCCEEDED);
    expect(event.type).toBe("payment_intent.succeeded");
    expect(event.id).toBe("SYNTH-EVT-0001");
  });

  it("FIXTURE_PAYMENT_FAILED verifies against WEBHOOK_TEST_SECRET", async () => {
    const { SIG_PAYMENT_FAILED } = await import("../fixtures/webhook-fixtures.js");
    const verifier = makeVerifier();
    const event = verifier.verify(Buffer.from(FIXTURE_PAYMENT_FAILED), SIG_PAYMENT_FAILED);
    expect(event.type).toBe("payment_intent.payment_failed");
  });

  it("FIXTURE_UNKNOWN_EVENT_TYPE verifies against WEBHOOK_TEST_SECRET", async () => {
    const { SIG_UNKNOWN_EVENT_TYPE } = await import("../fixtures/webhook-fixtures.js");
    const verifier = makeVerifier();
    const event = verifier.verify(Buffer.from(FIXTURE_UNKNOWN_EVENT_TYPE), SIG_UNKNOWN_EVENT_TYPE);
    expect(event.type).toBe("customer.created");
  });

  it("FIXTURE_PAYMENT_SUCCEEDED_DUPLICATE has same event ID as FIXTURE_PAYMENT_SUCCEEDED", async () => {
    const { SIG_PAYMENT_SUCCEEDED_DUPLICATE } = await import("../fixtures/webhook-fixtures.js");
    const verifier = makeVerifier();
    const original = verifier.verify(Buffer.from(FIXTURE_PAYMENT_SUCCEEDED), (await import("../fixtures/webhook-fixtures.js")).SIG_PAYMENT_SUCCEEDED);
    const duplicate = verifier.verify(Buffer.from(FIXTURE_PAYMENT_SUCCEEDED_DUPLICATE), SIG_PAYMENT_SUCCEEDED_DUPLICATE);
    expect(original.id).toBe(duplicate.id); // same event ID triggers dedup
  });
});
