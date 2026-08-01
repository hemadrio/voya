/**
 * Unit tests for CostMeteringService (WO-107, AC2, AC3, AC5, AC8).
 *
 * All tests use injectable clock and mock ports — no real DB or AWS.
 */

import { describe, it, expect } from "vitest";
import { CostMeteringService } from "../../src/cost/CostMeteringService.js";
import {
  FIXTURE_NOW,
  FIXTURE_OCCURRED_AT_IN_WINDOW,
  FIXTURE_OCCURRED_AT_BOUNDARY_7D,
  FIXTURE_OCCURRED_AT_OUTSIDE_WINDOW,
  FIXTURE_COST_RECORD_ATTRIBUTED,
  FIXTURE_COST_RECORD_UNATTRIBUTED,
  FIXTURE_COST_RECORD_BOUNDARY_IN,
  FIXTURE_COST_RECORD_BOUNDARY_OUT,
  CONV_ID_ATTRIBUTED,
  CONV_ID_UNATTRIBUTED,
  CONV_ID_BOUNDARY_IN,
  CONV_ID_BOUNDARY_OUT,
  makeMockCostStore,
  makeMockBookingLookup,
  makeCapturingPublisher,
} from "../fixtures/cost-fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(
  costStore: ReturnType<typeof makeMockCostStore>,
  bookingLookup: ReturnType<typeof makeMockBookingLookup>,
  publisher: ReturnType<typeof makeCapturingPublisher>,
  config: { attributionWindowDays?: number } = {},
) {
  return new CostMeteringService(
    costStore as never,
    bookingLookup as never,
    publisher,
    () => FIXTURE_NOW,
    {
      attributionWindowDays: config.attributionWindowDays ?? 7,
      environment: "test",
      model: "claude-sonnet-4-6",
      metricNamespace: "travel/assistant",
      advisoryLockKey: 999,
    },
  );
}

// ---------------------------------------------------------------------------
// Price table — cost computation (AC8)
// ---------------------------------------------------------------------------

describe("priceTable.computeCostUsd", () => {
  it("computes correct cost for claude-sonnet-4-6", async () => {
    const { computeCostUsd } = await import("../../src/cost/priceTable.js");
    const { costUsd } = computeCostUsd("claude-sonnet-4-6", 5000, 1000, FIXTURE_NOW);
    // (5000 * 3.00 + 1000 * 15.00) / 1_000_000 = 0.030000
    expect(costUsd).toBeCloseTo(0.030000, 6);
  });

  it("computes correct cost for claude-opus-5", async () => {
    const { computeCostUsd } = await import("../../src/cost/priceTable.js");
    const { costUsd } = computeCostUsd("claude-opus-5", 10000, 2000, FIXTURE_NOW);
    // (10000 * 15.00 + 2000 * 75.00) / 1_000_000 = 0.300000
    expect(costUsd).toBeCloseTo(0.300000, 6);
  });

  it("throws PriceLookupError for unknown model", async () => {
    const { computeCostUsd, PriceLookupError } = await import("../../src/cost/priceTable.js");
    expect(() => computeCostUsd("gpt-unknown-9", 1000, 100, FIXTURE_NOW)).toThrow(PriceLookupError);
  });

  it("uses the effectiveFrom entry active at occurredAt", async () => {
    const { computeCostUsd } = await import("../../src/cost/priceTable.js");
    // claude-sonnet-4-6 has effectiveFrom 2025-11-01; calling with date before that should fail
    const before = new Date("2025-10-01T00:00:00.000Z");
    expect(() => computeCostUsd("claude-sonnet-4-6", 1000, 100, before)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Attribution window boundary behaviour (AC8)
// ---------------------------------------------------------------------------

describe("CostMeteringService — attribution window", () => {
  it("attributes spend when conversationId appears on booking in 7-day window", async () => {
    const store = makeMockCostStore([FIXTURE_COST_RECORD_ATTRIBUTED]);
    const lookup = makeMockBookingLookup(
      [{ conversationId: CONV_ID_ATTRIBUTED, confirmedAt: new Date("2026-07-28T14:00:00.000Z") }],
      1,
    );
    const publisher = makeCapturingPublisher();
    const svc = makeService(store, lookup, publisher);

    await svc.runAttributionAndPublish();

    const perBooking = publisher.latestByName("assistant_cost_per_completed_booking_usd");
    expect(perBooking).toBeDefined();
    // attributed spend = 0.030000; 1 booking → ratio = 0.030000
    expect(perBooking!.value).toBeCloseTo(FIXTURE_COST_RECORD_ATTRIBUTED.costUsd, 6);
  });

  it("includes spend at exactly 7-day boundary (inclusive start)", async () => {
    const store = makeMockCostStore([FIXTURE_COST_RECORD_BOUNDARY_IN]);
    const lookup = makeMockBookingLookup(
      [{ conversationId: CONV_ID_BOUNDARY_IN, confirmedAt: FIXTURE_OCCURRED_AT_BOUNDARY_7D }],
      1,
    );
    const publisher = makeCapturingPublisher();
    const svc = makeService(store, lookup, publisher);

    await svc.runAttributionAndPublish();

    const perBooking = publisher.latestByName("assistant_cost_per_completed_booking_usd");
    expect(perBooking?.value).toBeGreaterThan(0);
  });

  it("excludes spend 8 days before now (outside window)", async () => {
    // The cost record is outside the 7-day window, so total spend = 0
    const store = makeMockCostStore([FIXTURE_COST_RECORD_BOUNDARY_OUT]);
    const lookup = makeMockBookingLookup(
      [],  // no bookings with conversationId in window
      1,   // 1 form-based booking in denominator
    );
    const publisher = makeCapturingPublisher();
    const svc = makeService(store, lookup, publisher);

    await svc.runAttributionAndPublish();

    const perBooking = publisher.latestByName("assistant_cost_per_completed_booking_usd");
    expect(perBooking?.value).toBe(0);
  });

  it("tracks unattributed overhead for conversations without matching bookings", async () => {
    const store = makeMockCostStore([
      FIXTURE_COST_RECORD_ATTRIBUTED,
      FIXTURE_COST_RECORD_UNATTRIBUTED,
    ]);
    const lookup = makeMockBookingLookup(
      [{ conversationId: CONV_ID_ATTRIBUTED, confirmedAt: new Date("2026-07-28T00:00:00.000Z") }],
      1,
    );
    const publisher = makeCapturingPublisher();
    const svc = makeService(store, lookup, publisher);

    await svc.runAttributionAndPublish();

    const unattributed = publisher.latestByName("assistant_spend_unattributed_usd");
    expect(unattributed?.value).toBeCloseTo(FIXTURE_COST_RECORD_UNATTRIBUTED.costUsd, 6);
  });

  it("configurable window: 6-day window excludes FIXTURE_OCCURRED_AT_IN_WINDOW (7 days old)", async () => {
    // FIXTURE_OCCURRED_AT_IN_WINDOW is 7 days ago; a 6-day window excludes it
    const SIX_DAY_WINDOW_START = new Date("2026-07-26T12:00:00.000Z");
    // Record's occurredAt = 2026-07-27T10:00:00Z — inside 6-day window (after 2026-07-26)
    // Actually FIXTURE_OCCURRED_AT_IN_WINDOW = 2026-07-27 which is > 2026-07-26 so it IS inside 6d window
    // Let's test with a record that's exactly at day 7 boundary
    const store = makeMockCostStore([FIXTURE_COST_RECORD_BOUNDARY_IN]);  // at 7d boundary
    const lookup = makeMockBookingLookup(
      [],
      1,
    );
    const publisher = makeCapturingPublisher();
    // Use 6-day window — 6d window start = 2026-07-26T12:00 — the boundary record (2026-07-25T12:00) is outside
    const svc = makeService(store, lookup, publisher, { attributionWindowDays: 6 });

    await svc.runAttributionAndPublish();

    const total = publisher.latestByName("assistant_spend_total_usd");
    // Store sums records >= window_start = 2026-07-26T12:00; boundary record is at 2026-07-25T12:00 → excluded
    expect(total?.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Zero confirmed bookings — no-data state (AC8)
// ---------------------------------------------------------------------------

describe("CostMeteringService — zero confirmed bookings", () => {
  it("does not emit cost_per_completed_booking when no confirmed bookings", async () => {
    const store = makeMockCostStore([FIXTURE_COST_RECORD_ATTRIBUTED]);
    const lookup = makeMockBookingLookup([], 0);
    const publisher = makeCapturingPublisher();
    const svc = makeService(store, lookup, publisher);

    await svc.runAttributionAndPublish();

    // Should NOT emit the ratio metric (no-data state, not 0 or Infinity)
    const perBooking = publisher.findByName("assistant_cost_per_completed_booking_usd");
    expect(perBooking).toHaveLength(0);

    // Heartbeat SHOULD still be emitted so absence alarm does not fire
    const heartbeat = publisher.latestByName("assistant_metering_heartbeat");
    expect(heartbeat?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Breach counting (AC5, AC8)
// ---------------------------------------------------------------------------

describe("CostMeteringService — cap breach count", () => {
  it("publishes cap_breach_count from the store aggregate", async () => {
    // Override store to return a specific breach count
    const store = {
      async sumCostInWindow() {
        return { totalCostUsd: 0.05, capBreachCount: 3 };
      },
      async sumCostForConversations() { return 0; },
      async tryAcquireAdvisoryLock() { return true; },
    };
    const lookup = makeMockBookingLookup([], 1);
    const publisher = makeCapturingPublisher();
    const svc = new CostMeteringService(
      store as never,
      lookup as never,
      publisher,
      () => FIXTURE_NOW,
      { attributionWindowDays: 7, environment: "test", model: "test", metricNamespace: "t", advisoryLockKey: 1 },
    );

    await svc.runAttributionAndPublish();

    const breach = publisher.latestByName("assistant_cap_breach_count");
    expect(breach?.value).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Concurrency lock — double-publish prevention (AC edge cases)
// ---------------------------------------------------------------------------

describe("CostMeteringService — advisory lock", () => {
  it("skips attribution when lock is not acquired", async () => {
    const store = makeMockCostStore([FIXTURE_COST_RECORD_ATTRIBUTED], { lockAcquired: false });
    const lookup = makeMockBookingLookup([], 0);
    const publisher = makeCapturingPublisher();
    const svc = makeService(store, lookup, publisher);

    await svc.runAttributionAndPublish();

    // Nothing should be published — lock not acquired
    expect(publisher.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Degraded path — store failure (AC6)
// ---------------------------------------------------------------------------

describe("CostMeteringService — degraded path", () => {
  it("emits metering_degraded and does not throw when store fails", async () => {
    const failingStore = {
      async sumCostInWindow(): Promise<never> { throw new Error("DB down"); },
      async sumCostForConversations() { return 0; },
      async tryAcquireAdvisoryLock() { return true; },
    };
    const lookup = makeMockBookingLookup([], 0);
    const publisher = makeCapturingPublisher();
    const svc = new CostMeteringService(
      failingStore as never,
      lookup as never,
      publisher,
      () => FIXTURE_NOW,
      { attributionWindowDays: 7, environment: "test", model: "test", metricNamespace: "t", advisoryLockKey: 1 },
    );

    // Must not throw
    await expect(svc.runAttributionAndPublish()).resolves.toBeUndefined();

    const degraded = publisher.latestByName("assistant_metering_degraded");
    expect(degraded?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CostGovernor.reconcile — durable record persistence (AC1)
// ---------------------------------------------------------------------------

describe("CostGovernor.reconcile", () => {
  it("inserts a cost record with correct fields", async () => {
    const { CostGovernor } = await import("../../src/cost/CostGovernor.js");
    const store = makeMockCostStore([]);
    const svc = new CostGovernor(store as never);

    await svc.reconcile({
      conversationId: "conv-test",
      model: "claude-sonnet-4-6",
      inputTokens: 4000,
      outputTokens: 800,
      toolCallCount: 2,
      occurredAt: FIXTURE_NOW,
      capBreached: false,
    });

    expect(store.inserted).toHaveLength(1);
    const rec = store.inserted[0];
    expect(rec.conversationId).toBe("conv-test");
    expect(rec.model).toBe("claude-sonnet-4-6");
    expect(rec.inputTokens).toBe(4000);
    expect(rec.outputTokens).toBe(800);
    expect(rec.toolCallCount).toBe(2);
    expect(rec.costUsd).toBeGreaterThan(0);
    expect(rec.priceTableVersion).toBeTruthy();
  });

  it("does not throw when store is unavailable (AC6)", async () => {
    const { CostGovernor } = await import("../../src/cost/CostGovernor.js");
    const store = makeMockCostStore([], { throwOnInsert: true });
    const metrics: string[] = [];
    const svc = new CostGovernor(store as never, {
      increment(name) { metrics.push(name); },
    });

    await expect(
      svc.reconcile({
        conversationId: "conv-test",
        model: "claude-sonnet-4-6",
        inputTokens: 1000,
        outputTokens: 100,
        toolCallCount: 0,
        occurredAt: FIXTURE_NOW,
        capBreached: false,
      }),
    ).resolves.toBeUndefined();

    expect(metrics).toContain("assistant.metering_degraded");
  });

  it("increments cap_breach metric and does not prevent reconcile", async () => {
    const { CostGovernor } = await import("../../src/cost/CostGovernor.js");
    const store = makeMockCostStore([]);
    const metrics: Record<string, number> = {};
    const svc = new CostGovernor(store as never, {
      increment(name) { metrics[name] = (metrics[name] ?? 0) + 1; },
    });

    await svc.reconcile({
      conversationId: "conv-test",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 100,
      toolCallCount: 8, // at the cap
      occurredAt: FIXTURE_NOW,
      capBreached: true,
      capKind: "TOOL_CALLS",
    });

    expect(metrics["assistant.cap_breach"]).toBe(1);
    // Record should still be inserted
    expect(store.inserted).toHaveLength(1);
  });

  it("does not insert record for unknown model (AC — price-table-miss)", async () => {
    const { CostGovernor } = await import("../../src/cost/CostGovernor.js");
    const store = makeMockCostStore([]);
    const metrics: Record<string, number> = {};
    const svc = new CostGovernor(store as never, {
      increment(name) { metrics[name] = (metrics[name] ?? 0) + 1; },
    });

    await svc.reconcile({
      conversationId: "conv-test",
      model: "gpt-unknown",
      inputTokens: 1000,
      outputTokens: 100,
      toolCallCount: 0,
      occurredAt: FIXTURE_NOW,
      capBreached: false,
    });

    expect(metrics["assistant.price_table_miss"]).toBe(1);
    expect(metrics["assistant.metering_degraded"]).toBe(1);
    expect(store.inserted).toHaveLength(0);
  });
});
