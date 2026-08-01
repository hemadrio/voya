/**
 * Unit tests for FunnelRepository — six reporting queries (WO-106 AC7, AC8).
 *
 * Strategy: inject a fake FunnelDbClient that returns pre-computed rows built
 * from the synthetic fixture cohorts defined in tests/fixtures/funnel-fixtures.ts.
 * No real database is required.
 *
 * Covers:
 *   AC7  — search-to-booking (4%), assistant-attributed (20%), multi-category (30%),
 *           guest-to-registration (25%), conversation-completion (70%), repeat-booking (15%)
 *   AC8  — incompleteWindow flag when window extends past purge_after
 */

import { describe, it, expect } from "vitest";
import { FunnelRepository } from "../../src/repositories/FunnelRepository.js";
import type { FunnelDbClient } from "../../src/repositories/FunnelRepository.js";
import type { MeasurementWindow } from "@travel/contracts";
import {
  WINDOW_START,
  WINDOW_END,
  FIXTURE_STATS,
} from "../../../../tests/fixtures/funnel-fixtures.js";

// ---------------------------------------------------------------------------
// Measurement windows used across tests
// ---------------------------------------------------------------------------

const WINDOW: MeasurementWindow = {
  fromDate: WINDOW_START,
  toDate: WINDOW_END,
};

// A window whose toDate is BEFORE the earliest purge_after (400 days from start)
// → incompleteWindow should be FALSE
const CLEAN_WINDOW: MeasurementWindow = {
  fromDate: WINDOW_START,
  toDate: new Date(WINDOW_START.getTime() + 30 * 86_400_000), // 30 days, within retention
};

// A window where the earliest event's purge_after is BEFORE toDate
// → incompleteWindow should be TRUE
const STALE_WINDOW: MeasurementWindow = {
  fromDate: new Date(WINDOW_START.getTime() - 450 * 86_400_000), // 450 days ago
  toDate: new Date(WINDOW_START.getTime() - 10 * 86_400_000),   // 10 days ago (purge_after < toDate)
};

// ---------------------------------------------------------------------------
// Fake DB client builder
// ---------------------------------------------------------------------------

type QueryHandler = (sql: string) => unknown[];

function buildFakeDb(handlers: QueryHandler[]): FunnelDbClient & { callCount: number } {
  let callIndex = 0;
  return {
    get callCount() { return callIndex; },
    $queryRaw<T>(strings: TemplateStringsArray, ..._values: unknown[]): Promise<T> {
      const sql = strings.join("?");
      const handler = handlers[callIndex++];
      if (!handler) throw new Error(`Unexpected $queryRaw call #${callIndex}: ${sql}`);
      return Promise.resolve(handler(sql) as T);
    },
  };
}

// Cohort sizes from fixture stats
const { cohortASize, cohortBSize, cohortCSize, cohortDSize, cohortESize } = FIXTURE_STATS;

// ---------------------------------------------------------------------------
// Helper: purge_after stub rows
// ---------------------------------------------------------------------------

function minPurgeRow(minPurge: Date | null) {
  return [{ min_purge: minPurge }];
}

// A purge_after safely in the future (well past any test toDate)
const FUTURE_PURGE = new Date(WINDOW_END.getTime() + 500 * 86_400_000);
// A purge_after in the past (triggers incompleteWindow)
const PAST_PURGE = new Date(STALE_WINDOW.toDate.getTime() - 1);

// ---------------------------------------------------------------------------
// 1. Search-to-booking conversion
// ---------------------------------------------------------------------------

describe("FunnelRepository.getSearchToBookingConversion", () => {
  it("returns correct counts from all cohorts within the window", async () => {
    // search_performed: cohortA (80) + cohortB (40) + outside-window (excluded) = 120
    // booking_created:  cohortA (80) + cohortC (40, 2 per actor) = 120
    const searchCount = cohortASize + cohortBSize; // 120
    const bookingCount = cohortASize + cohortCSize * 2; // 120 (cohortC has 2 bookings per actor)

    const db = buildFakeDb([
      // Query 1: event_type counts
      () => [
        { event_type: "search_performed", cnt: BigInt(searchCount) },
        { event_type: "booking_created", cnt: BigInt(bookingCount) },
      ],
      // Query 2: isIncompleteWindow MIN(purge_after)
      () => minPurgeRow(FUTURE_PURGE),
    ]);

    const repo = new FunnelRepository(db);
    const result = await repo.getSearchToBookingConversion(WINDOW);

    expect(result.searchCount).toBe(searchCount);
    expect(result.bookingCount).toBe(bookingCount);
    expect(result.conversionRate).toBeCloseTo(bookingCount / searchCount);
    expect(result.targetRate).toBe(0.04);
    expect(result.incompleteWindow).toBe(false);
    expect(db.callCount).toBe(2);
  });

  it("returns null conversionRate when searchCount is zero", async () => {
    const db = buildFakeDb([
      () => [],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getSearchToBookingConversion(WINDOW);
    expect(result.conversionRate).toBeNull();
  });

  it("sets incompleteWindow=true when MIN(purge_after) < toDate", async () => {
    const db = buildFakeDb([
      () => [
        { event_type: "search_performed", cnt: 10n },
        { event_type: "booking_created", cnt: 1n },
      ],
      () => minPurgeRow(PAST_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getSearchToBookingConversion(STALE_WINDOW);
    expect(result.incompleteWindow).toBe(true);
  });

  it("sets incompleteWindow=false when no events exist in window", async () => {
    const db = buildFakeDb([
      () => [],
      () => minPurgeRow(null),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getSearchToBookingConversion(CLEAN_WINDOW);
    expect(result.incompleteWindow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Assistant-attributed conversion
// ---------------------------------------------------------------------------

describe("FunnelRepository.getAssistantConversion", () => {
  it("returns correct attribution rate for cohortA assistant users", async () => {
    // Every 5th actor in cohortA (80 / 5 = 16) used the assistant
    const assistantBookings = Math.floor(cohortASize / 5); // 16
    const totalBookings = cohortASize + cohortCSize * 2;   // 120

    const db = buildFakeDb([
      () => [{ cnt: BigInt(assistantBookings) }],
      () => [{ cnt: BigInt(totalBookings) }],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getAssistantConversion(WINDOW);

    expect(result.assistantBookingCount).toBe(assistantBookings);
    expect(result.totalBookingCount).toBe(totalBookings);
    expect(result.attributionRate).toBeCloseTo(assistantBookings / totalBookings);
    expect(result.targetRate).toBe(0.20);
    expect(result.incompleteWindow).toBe(false);
  });

  it("returns null attributionRate when totalBookingCount is zero", async () => {
    const db = buildFakeDb([
      () => [{ cnt: 0n }],
      () => [{ cnt: 0n }],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getAssistantConversion(WINDOW);
    expect(result.attributionRate).toBeNull();
  });

  it("sets incompleteWindow=true on stale window", async () => {
    const db = buildFakeDb([
      () => [{ cnt: 5n }],
      () => [{ cnt: 20n }],
      () => minPurgeRow(PAST_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getAssistantConversion(STALE_WINDOW);
    expect(result.incompleteWindow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-category attachment
// ---------------------------------------------------------------------------

describe("FunnelRepository.getMultiCategoryAttachment", () => {
  it("counts multi-category itineraries from cohortC", async () => {
    // cohortC: each actor has 1 itinerary with 2 offer_selected categories → multi
    // cohortA: each actor has 1 itinerary with 1 category → single
    const multiCount = cohortCSize;        // 20 multi-category itineraries
    const singleCount = cohortASize;       // 80 single-category itineraries

    const db = buildFakeDb([
      () => [
        { is_multi: true, cnt: BigInt(multiCount) },
        { is_multi: false, cnt: BigInt(singleCount) },
      ],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getMultiCategoryAttachment(WINDOW);

    expect(result.multiCategoryItineraryCount).toBe(multiCount);
    expect(result.totalItineraryCount).toBe(multiCount + singleCount);
    expect(result.attachmentRate).toBeCloseTo(multiCount / (multiCount + singleCount));
    expect(result.targetRate).toBe(0.30);
    expect(result.incompleteWindow).toBe(false);
  });

  it("returns null attachmentRate when no itineraries in window", async () => {
    const db = buildFakeDb([
      () => [],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getMultiCategoryAttachment(CLEAN_WINDOW);
    expect(result.attachmentRate).toBeNull();
    expect(result.totalItineraryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Guest-to-registration conversion
// ---------------------------------------------------------------------------

describe("FunnelRepository.getGuestToRegistration", () => {
  it("counts guest sessions and registrations from cohortD", async () => {
    const guestSessions = cohortDSize;    // 10 session_started with isAnonymous
    const registrations = cohortDSize;    // 10 guest_registered

    const db = buildFakeDb([
      () => [{ cnt: BigInt(guestSessions) }],
      () => [{ cnt: BigInt(registrations) }],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getGuestToRegistration(WINDOW);

    expect(result.guestSessionCount).toBe(guestSessions);
    expect(result.registrationCount).toBe(registrations);
    expect(result.conversionRate).toBeCloseTo(1.0); // 100% in this cohort
    expect(result.targetRate).toBe(0.25);
    expect(result.incompleteWindow).toBe(false);
  });

  it("returns null conversionRate when guestSessionCount is zero", async () => {
    const db = buildFakeDb([
      () => [{ cnt: 0n }],
      () => [{ cnt: 0n }],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getGuestToRegistration(WINDOW);
    expect(result.conversionRate).toBeNull();
  });

  it("handles window straddling cohort boundary (partial registrations)", async () => {
    // 10 guest sessions started, only 5 registered within the narrow window
    const db = buildFakeDb([
      () => [{ cnt: 10n }],
      () => [{ cnt: 5n }],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getGuestToRegistration(CLEAN_WINDOW);
    expect(result.conversionRate).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// 5. Conversation completion to shortlist
// ---------------------------------------------------------------------------

describe("FunnelRepository.getConversationCompletion", () => {
  it("counts conversations started and shortlists presented", async () => {
    // Every 5th cohortA actor (16) has a conversation with shortlist_presented
    const assistantCount = Math.floor(cohortASize / 5); // 16

    const db = buildFakeDb([
      () => [{ cnt: BigInt(assistantCount) }],  // conversations started
      () => [{ cnt: BigInt(assistantCount) }],  // shortlists presented
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getConversationCompletion(WINDOW);

    expect(result.conversationsStarted).toBe(assistantCount);
    expect(result.shortlistsPresentedCount).toBe(assistantCount);
    expect(result.completionRate).toBeCloseTo(1.0);
    expect(result.targetRate).toBe(0.70);
    expect(result.incompleteWindow).toBe(false);
  });

  it("returns null completionRate when no conversations started", async () => {
    const db = buildFakeDb([
      () => [{ cnt: 0n }],
      () => [{ cnt: 0n }],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getConversationCompletion(WINDOW);
    expect(result.completionRate).toBeNull();
  });

  it("returns partial completion rate when some conversations did not shortlist", async () => {
    const db = buildFakeDb([
      () => [{ cnt: 20n }],
      () => [{ cnt: 14n }], // 70% completed
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getConversationCompletion(WINDOW);
    expect(result.completionRate).toBeCloseTo(0.70);
  });

  it("sets incompleteWindow=true on stale window", async () => {
    const db = buildFakeDb([
      () => [{ cnt: 10n }],
      () => [{ cnt: 7n }],
      () => minPurgeRow(PAST_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getConversationCompletion(STALE_WINDOW);
    expect(result.incompleteWindow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Repeat booking rate
// ---------------------------------------------------------------------------

describe("FunnelRepository.getRepeatBookingRate", () => {
  it("identifies repeat bookers from cohortE", async () => {
    // cohortE: 10 actors each with 2 payments → 10 unique bookers, 10 repeat
    // cohortA: 80 actors each with 1 payment → 80 unique, 0 repeat
    const cohortEActors = Array.from({ length: cohortESize }, (_, i) => ({
      actor: `actor-e-${i}`,
      booking_count: 2n,
    }));
    const cohortAActors = Array.from({ length: cohortASize }, (_, i) => ({
      actor: `actor-a-${i}`,
      booking_count: 1n,
    }));

    const db = buildFakeDb([
      () => [...cohortEActors, ...cohortAActors],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getRepeatBookingRate(WINDOW);

    expect(result.uniqueBookers).toBe(cohortESize + cohortASize);
    expect(result.repeatBookers).toBe(cohortESize);
    expect(result.repeatRate).toBeCloseTo(cohortESize / (cohortESize + cohortASize));
    expect(result.targetRate).toBe(0.15);
    expect(result.windowDays).toBe(180);
    expect(result.incompleteWindow).toBe(false);
  });

  it("accepts a custom windowDays parameter", async () => {
    const db = buildFakeDb([
      () => [{ actor: "x", booking_count: 3n }],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getRepeatBookingRate(WINDOW, 90);
    expect(result.windowDays).toBe(90);
  });

  it("returns null repeatRate when no unique bookers", async () => {
    const db = buildFakeDb([
      () => [],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getRepeatBookingRate(WINDOW);
    expect(result.uniqueBookers).toBe(0);
    expect(result.repeatBookers).toBe(0);
    expect(result.repeatRate).toBeNull();
  });

  it("sets incompleteWindow=true on stale window", async () => {
    const db = buildFakeDb([
      () => [{ actor: "x", booking_count: 2n }],
      () => minPurgeRow(PAST_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getRepeatBookingRate(STALE_WINDOW);
    expect(result.incompleteWindow).toBe(true);
  });

  it("excludes single-booking actors from repeatBookers count", async () => {
    const db = buildFakeDb([
      () => [
        { actor: "a", booking_count: 1n },
        { actor: "b", booking_count: 2n },
        { actor: "c", booking_count: 3n },
        { actor: "d", booking_count: 1n },
      ],
      () => minPurgeRow(FUTURE_PURGE),
    ]);
    const repo = new FunnelRepository(db);
    const result = await repo.getRepeatBookingRate(WINDOW);
    expect(result.uniqueBookers).toBe(4);
    expect(result.repeatBookers).toBe(2); // b and c
    expect(result.repeatRate).toBeCloseTo(0.5);
  });
});
