/**
 * Unit tests for FunnelEvent schema (WO-106 AC1, AC4, AC10).
 */

import { describe, it, expect } from "vitest";
import { FunnelEventSchema, buildFunnelEvent } from "../../src/funnel/funnelEvent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    eventType: "search_performed",
    occurredAt: "2026-01-15T12:00:00.000Z",
    correlationId: "corr-test-001",
    pseudonymousActorId: "a".repeat(64), // 64-char HMAC hex
    sessionId: "sess-test-001",
    category: "FLIGHT",
    attributes: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1: Schema structure
// ---------------------------------------------------------------------------

describe("FunnelEventSchema — accepted shapes", () => {
  it("parses a valid search_performed event", () => {
    const result = FunnelEventSchema.safeParse(validEvent());
    expect(result.success).toBe(true);
  });

  it("parses all 12 event types", () => {
    const types = [
      "session_started", "search_performed", "results_viewed", "offer_selected",
      "itinerary_created", "booking_created", "payment_confirmed",
      "conversation_started", "shortlist_presented", "conversation_handoff",
      "guest_registered", "preference_saved",
    ];
    for (const eventType of types) {
      const result = FunnelEventSchema.safeParse(validEvent({ eventType }));
      expect(result.success, `expected ${eventType} to pass`).toBe(true);
    }
  });

  it("accepts all 7 category values", () => {
    const categories = ["FLIGHT", "HOTEL", "CAR", "MULTI", "ASSISTANT", "AUTH", "UNKNOWN"];
    for (const category of categories) {
      expect(FunnelEventSchema.safeParse(validEvent({ category })).success).toBe(true);
    }
  });

  it("accepts optional conversationId, itineraryId, bookingId", () => {
    const result = FunnelEventSchema.safeParse(validEvent({
      conversationId: "conv-001",
      itineraryId: "itin-001",
      bookingId: "book-001",
    }));
    expect(result.success).toBe(true);
  });

  it("accepts bounded attributes up to 20 keys", () => {
    const attrs: Record<string, number> = {};
    for (let i = 0; i < 20; i++) attrs[`k${i}`] = i;
    expect(FunnelEventSchema.safeParse(validEvent({ attributes: attrs })).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1: Schema validation failures
// ---------------------------------------------------------------------------

describe("FunnelEventSchema — rejected shapes", () => {
  it("rejects an unknown event type", () => {
    expect(FunnelEventSchema.safeParse(validEvent({ eventType: "unknown_type" })).success).toBe(false);
  });

  it("rejects attributes with more than 20 keys", () => {
    const attrs: Record<string, number> = {};
    for (let i = 0; i < 21; i++) attrs[`k${i}`] = i;
    expect(FunnelEventSchema.safeParse(validEvent({ attributes: attrs })).success).toBe(false);
  });

  it("rejects attributes with nested objects", () => {
    expect(FunnelEventSchema.safeParse(validEvent({
      attributes: { nested: { key: "value" } },
    })).success).toBe(false);
  });

  it("rejects schemaVersion other than 1", () => {
    expect(FunnelEventSchema.safeParse(validEvent({ schemaVersion: 2 })).success).toBe(false);
  });

  it("rejects missing correlationId", () => {
    const ev = validEvent();
    delete (ev as Record<string, unknown>)["correlationId"];
    expect(FunnelEventSchema.safeParse(ev).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4: PII rejection — forbidden fields cause parse failure
// ---------------------------------------------------------------------------

describe("FunnelEventSchema — PII field rejection", () => {
  const piiFields = [
    ["email", "traveler@example.com"],
    ["firstName", "Alice"],
    ["lastName", "Smith"],
    ["dateOfBirth", "1990-01-01"],
    ["passportNumber", "AB1234567"],
    ["phone", "+44123456789"],
    ["userId", "00000000-0000-0000-0000-000000000001"],
  ] as const;

  for (const [field, value] of piiFields) {
    it(`rejects a payload containing '${field}'`, () => {
      const result = FunnelEventSchema.safeParse(validEvent({ [field]: value }));
      expect(result.success, `expected '${field}' to be rejected`).toBe(false);
    });
  }

  it("rejects any extra/unknown field via strict mode", () => {
    expect(FunnelEventSchema.safeParse(validEvent({ unknownField: "x" })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildFunnelEvent helper
// ---------------------------------------------------------------------------

describe("buildFunnelEvent", () => {
  it("fills schemaVersion automatically", () => {
    const ev = buildFunnelEvent({
      eventType: "booking_created",
      occurredAt: "2026-01-15T12:00:00.000Z",
      correlationId: "corr-001",
      pseudonymousActorId: "b".repeat(64),
      sessionId: "sess-001",
      category: "HOTEL",
      attributes: {},
    });
    expect(ev.schemaVersion).toBe(1);
  });
});
