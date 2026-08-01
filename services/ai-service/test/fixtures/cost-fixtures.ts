/**
 * Cost metering test fixtures (WO-107).
 *
 * Provides typed constants for:
 *  - Conversation cost records (attributed, unattributed, boundary, form-only)
 *  - Confirmed bookings (with/without conversationId, refunded, outside window)
 *  - Attribution window boundary cases
 */

import type { AssistantCostRecord } from "../../src/cost/CostGovernor.js";

// ---------------------------------------------------------------------------
// Reference timestamps
//
// All dates are absolute so tests do not depend on the system clock.
// ---------------------------------------------------------------------------

/** Reference "now" for all fixture computations. */
export const FIXTURE_NOW = new Date("2026-08-01T12:00:00.000Z");

/** Attribution window: 7 days before FIXTURE_NOW. */
export const FIXTURE_WINDOW_START = new Date("2026-07-25T12:00:00.000Z");

/** Cost record within the attribution window. */
export const FIXTURE_OCCURRED_AT_IN_WINDOW = new Date("2026-07-27T10:00:00.000Z");

/** Cost record at exactly day 7 (boundary — should be IN window). */
export const FIXTURE_OCCURRED_AT_BOUNDARY_7D = new Date("2026-07-25T12:00:00.000Z");

/** Cost record 8 days before now (boundary — should be OUTSIDE window). */
export const FIXTURE_OCCURRED_AT_OUTSIDE_WINDOW = new Date("2026-07-24T11:59:59.000Z");

// ---------------------------------------------------------------------------
// Conversation IDs
// ---------------------------------------------------------------------------

export const CONV_ID_ATTRIBUTED = "conv-attributed-001";
export const CONV_ID_UNATTRIBUTED = "conv-unattributed-002";
export const CONV_ID_BOUNDARY_IN = "conv-boundary-in-003";
export const CONV_ID_BOUNDARY_OUT = "conv-boundary-out-004";

// ---------------------------------------------------------------------------
// Cost record fixtures
// ---------------------------------------------------------------------------

/** Standard attributed cost record (conversation led to a booking). */
export const FIXTURE_COST_RECORD_ATTRIBUTED: AssistantCostRecord = {
  conversationId: CONV_ID_ATTRIBUTED,
  model: "claude-sonnet-4-6",
  inputTokens: 5000,
  outputTokens: 1000,
  toolCallCount: 3,
  costUsd: 0.030000,  // (5000 * 3.00 + 1000 * 15.00) / 1_000_000 = 0.030
  priceTableVersion: "2026-08-01",
  occurredAt: FIXTURE_OCCURRED_AT_IN_WINDOW,
  purgeAfter: new Date("2028-07-27T10:00:00.000Z"),
};

/** Unattributed cost record (no booking confirmed in window). */
export const FIXTURE_COST_RECORD_UNATTRIBUTED: AssistantCostRecord = {
  conversationId: CONV_ID_UNATTRIBUTED,
  model: "claude-sonnet-4-6",
  inputTokens: 3000,
  outputTokens: 500,
  toolCallCount: 2,
  costUsd: 0.016500,  // (3000 * 3.00 + 500 * 15.00) / 1_000_000 = 0.016500
  priceTableVersion: "2026-08-01",
  occurredAt: FIXTURE_OCCURRED_AT_IN_WINDOW,
  purgeAfter: new Date("2028-07-27T10:00:00.000Z"),
};

/** Boundary-in: occurred exactly 7 days before now (inside window). */
export const FIXTURE_COST_RECORD_BOUNDARY_IN: AssistantCostRecord = {
  ...FIXTURE_COST_RECORD_ATTRIBUTED,
  conversationId: CONV_ID_BOUNDARY_IN,
  occurredAt: FIXTURE_OCCURRED_AT_BOUNDARY_7D,
};

/** Boundary-out: occurred 8 days ago (outside 7-day window). */
export const FIXTURE_COST_RECORD_BOUNDARY_OUT: AssistantCostRecord = {
  ...FIXTURE_COST_RECORD_ATTRIBUTED,
  conversationId: CONV_ID_BOUNDARY_OUT,
  occurredAt: FIXTURE_OCCURRED_AT_OUTSIDE_WINDOW,
};

/** High cost record — represents a conversation that breached the USD 0.75 ceiling alone. */
export const FIXTURE_COST_RECORD_HIGH: AssistantCostRecord = {
  conversationId: "conv-high-spend-005",
  model: "claude-opus-5",
  inputTokens: 30000,
  outputTokens: 5000,
  toolCallCount: 8,
  costUsd: 0.825000,  // (30000 * 15.00 + 5000 * 75.00) / 1_000_000 = 0.825
  priceTableVersion: "2026-08-01",
  occurredAt: FIXTURE_OCCURRED_AT_IN_WINDOW,
  purgeAfter: new Date("2028-07-27T10:00:00.000Z"),
};

// ---------------------------------------------------------------------------
// Booking fixtures
// ---------------------------------------------------------------------------

/** AI-assisted booking — has conversationId that matches attributed cost record. */
export const FIXTURE_BOOKING_AI = {
  bookingId: "booking-ai-001",
  conversationId: CONV_ID_ATTRIBUTED,
  confirmedAt: new Date("2026-07-28T14:00:00.000Z"),
  status: "CONFIRMED",
};

/** AI-assisted booking at boundary — conversationId matches boundary-in record. */
export const FIXTURE_BOOKING_AI_BOUNDARY = {
  bookingId: "booking-ai-boundary-002",
  conversationId: CONV_ID_BOUNDARY_IN,
  confirmedAt: new Date("2026-07-26T10:00:00.000Z"),
  status: "CONFIRMED",
};

/** Form-based booking — no conversationId; in denominator only. */
export const FIXTURE_BOOKING_FORM = {
  bookingId: "booking-form-003",
  conversationId: null,
  confirmedAt: new Date("2026-07-29T09:00:00.000Z"),
  status: "CONFIRMED",
};

/** Refunded booking — must be excluded from denominator per WO-107 edge cases. */
export const FIXTURE_BOOKING_REFUNDED = {
  bookingId: "booking-refunded-004",
  conversationId: "conv-refunded-006",
  confirmedAt: new Date("2026-07-27T11:00:00.000Z"),
  status: "CONFIRMED",
  fullyRefunded: true,
};

/** Booking confirmed 30 days after last conversation activity (outside 7-day window). */
export const FIXTURE_BOOKING_LATE_CONFIRMATION = {
  bookingId: "booking-late-005",
  conversationId: "conv-late-007",
  confirmedAt: FIXTURE_NOW,  // confirmed "today"
  lastConversationActivityAt: new Date("2026-07-01T10:00:00.000Z"), // 31 days ago
  status: "CONFIRMED",
};

// ---------------------------------------------------------------------------
// Mock store and lookup implementations
// ---------------------------------------------------------------------------

/** A minimal in-memory CostRecordStore for unit tests. */
export function makeMockCostStore(
  records: AssistantCostRecord[],
  opts: { lockAcquired?: boolean; throwOnInsert?: boolean } = {},
) {
  return {
    async sumCostInWindow(start: Date, end: Date) {
      const inWindow = records.filter(
        (r) => r.occurredAt >= start && r.occurredAt < end,
      );
      return {
        totalCostUsd: inWindow.reduce((s, r) => s + r.costUsd, 0),
        capBreachCount: 0,
      };
    },

    async sumCostForConversations(ids: string[], start: Date, end: Date) {
      const inWindow = records.filter(
        (r) =>
          ids.includes(r.conversationId) &&
          r.occurredAt >= start &&
          r.occurredAt < end,
      );
      return inWindow.reduce((s, r) => s + r.costUsd, 0);
    },

    async tryAcquireAdvisoryLock(_key: number) {
      return opts.lockAcquired ?? true;
    },

    inserted: [] as AssistantCostRecord[],
    async insert(record: AssistantCostRecord) {
      if (opts.throwOnInsert) throw new Error("DB unavailable");
      this.inserted.push(record);
    },
  };
}

/** A minimal in-memory BookingLookupPort for unit tests. */
export function makeMockBookingLookup(
  confirmedWithConv: Array<{ conversationId: string; confirmedAt: Date }>,
  totalConfirmedCount: number,
) {
  return {
    async findConfirmedWithConversation(_start: Date, _end: Date) {
      return confirmedWithConv;
    },
    async countConfirmedBookings(_start: Date, _end: Date) {
      return totalConfirmedCount;
    },
  };
}

/** A capturing MetricPublisher for test assertions. */
export function makeCapturingPublisher() {
  const published: Array<{ name: string; value: number; unit: string; dimensions?: Record<string, string> }> = [];
  return {
    published,
    publish(name: string, value: number, unit: string, dimensions?: Record<string, string>) {
      published.push({ name, value, unit, dimensions });
    },
    findByName(name: string) {
      return published.filter((p) => p.name === name);
    },
    latestByName(name: string) {
      const all = published.filter((p) => p.name === name);
      return all[all.length - 1];
    },
  };
}
