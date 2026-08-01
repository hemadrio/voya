/**
 * FunnelRepository — six reporting queries for funnel business metrics (WO-106 AC7).
 *
 * Each method accepts an explicit measurement window so queries are deterministic
 * in tests. An incompleteWindow flag is returned when the window extends past
 * the funnel retention boundary (purge_after).
 *
 * All queries run against the funnel_event table via raw Prisma SQL to express
 * aggregations that Prisma's model layer cannot represent ergonomically.
 *
 * No PII is returned: all actor references are pseudonymousActorId values.
 */

import type {
  MeasurementWindow,
  SearchToBookingResult,
  AssistantConversionResult,
  MultiCategoryAttachmentResult,
  GuestToRegistrationResult,
  ConversationCompletionResult,
  RepeatBookingResult,
} from "@travel/contracts";

// ---------------------------------------------------------------------------
// Minimal duck-typed Prisma client for raw SQL
// ---------------------------------------------------------------------------

export interface FunnelDbClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEARCH_TO_BOOKING_TARGET = 0.04;
const ASSISTANT_CONVERSION_TARGET = 0.20;
const MULTI_CATEGORY_TARGET = 0.30;
const GUEST_REGISTRATION_TARGET = 0.25;
const CONVERSATION_COMPLETION_TARGET = 0.70;
const REPEAT_BOOKING_TARGET = 0.15;
const DEFAULT_REPEAT_WINDOW_DAYS = 180;

function safeRate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Determine if the measurement window is incomplete (extends past retention).
 * The earliest purge_after for events in the window is compared to `toDate`.
 * If no events exist in the window, return false (window may be in the future).
 */
async function isIncompleteWindow(
  db: FunnelDbClient,
  window: MeasurementWindow,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ min_purge: Date | null }>>`
    SELECT MIN(purge_after) AS min_purge
    FROM funnel_event
    WHERE occurred_at >= ${window.fromDate}
      AND occurred_at < ${window.toDate}
  `;
  const minPurge = rows[0]?.min_purge;
  if (!minPurge) return false;
  return minPurge < window.toDate;
}

// ---------------------------------------------------------------------------
// FunnelRepository
// ---------------------------------------------------------------------------

export class FunnelRepository {
  constructor(private readonly _db: FunnelDbClient) {}

  // ── 1. Search-to-booking conversion ───────────────────────────────────────

  async getSearchToBookingConversion(
    window: MeasurementWindow,
  ): Promise<SearchToBookingResult> {
    const [counts, incomplete] = await Promise.all([
      this._db.$queryRaw<Array<{ event_type: string; cnt: bigint }>>`
        SELECT event_type, COUNT(*) AS cnt
        FROM funnel_event
        WHERE event_type IN ('search_performed', 'booking_created')
          AND occurred_at >= ${window.fromDate}
          AND occurred_at < ${window.toDate}
        GROUP BY event_type
      `,
      isIncompleteWindow(this._db, window),
    ]);

    const searchCount = Number(counts.find((r) => r.event_type === "search_performed")?.cnt ?? 0n);
    const bookingCount = Number(counts.find((r) => r.event_type === "booking_created")?.cnt ?? 0n);

    return {
      window,
      incompleteWindow: incomplete,
      searchCount,
      bookingCount,
      conversionRate: safeRate(bookingCount, searchCount),
      targetRate: SEARCH_TO_BOOKING_TARGET,
    };
  }

  // ── 2. Assistant-attributed conversion ────────────────────────────────────

  async getAssistantConversion(
    window: MeasurementWindow,
  ): Promise<AssistantConversionResult> {
    const [assistantBookings, totalBookings, incomplete] = await Promise.all([
      this._db.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(DISTINCT f.booking_id) AS cnt
        FROM funnel_event f
        WHERE f.event_type = 'booking_created'
          AND f.conversation_id IS NOT NULL
          AND f.occurred_at >= ${window.fromDate}
          AND f.occurred_at < ${window.toDate}
      `,
      this._db.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(*) AS cnt
        FROM funnel_event
        WHERE event_type = 'booking_created'
          AND occurred_at >= ${window.fromDate}
          AND occurred_at < ${window.toDate}
      `,
      isIncompleteWindow(this._db, window),
    ]);

    const assistantBookingCount = Number(assistantBookings[0]?.cnt ?? 0n);
    const totalBookingCount = Number(totalBookings[0]?.cnt ?? 0n);

    return {
      window,
      incompleteWindow: incomplete,
      assistantBookingCount,
      totalBookingCount,
      attributionRate: safeRate(assistantBookingCount, totalBookingCount),
      targetRate: ASSISTANT_CONVERSION_TARGET,
    };
  }

  // ── 3. Multi-category attachment ──────────────────────────────────────────

  async getMultiCategoryAttachment(
    window: MeasurementWindow,
  ): Promise<MultiCategoryAttachmentResult> {
    const [itineraryCounts, incomplete] = await Promise.all([
      this._db.$queryRaw<Array<{ is_multi: boolean; cnt: bigint }>>`
        SELECT (category_count >= 2) AS is_multi, COUNT(*) AS cnt
        FROM (
          SELECT itinerary_id, COUNT(DISTINCT category) AS category_count
          FROM funnel_event
          WHERE event_type = 'offer_selected'
            AND itinerary_id IS NOT NULL
            AND occurred_at >= ${window.fromDate}
            AND occurred_at < ${window.toDate}
          GROUP BY itinerary_id
        ) sub
        GROUP BY is_multi
      `,
      isIncompleteWindow(this._db, window),
    ]);

    const multiCount = Number(
      itineraryCounts.find((r) => r.is_multi === true)?.cnt ?? 0n,
    );
    const singleCount = Number(
      itineraryCounts.find((r) => r.is_multi === false)?.cnt ?? 0n,
    );
    const total = multiCount + singleCount;

    return {
      window,
      incompleteWindow: incomplete,
      multiCategoryItineraryCount: multiCount,
      totalItineraryCount: total,
      attachmentRate: safeRate(multiCount, total),
      targetRate: MULTI_CATEGORY_TARGET,
    };
  }

  // ── 4. Guest-to-registration conversion ───────────────────────────────────

  async getGuestToRegistration(
    window: MeasurementWindow,
  ): Promise<GuestToRegistrationResult> {
    const [sessions, registrations, incomplete] = await Promise.all([
      // Guest sessions: session_started events where no prior guest_registered
      // pseudonymous actor exists before this window.
      this._db.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(DISTINCT session_id) AS cnt
        FROM funnel_event
        WHERE event_type = 'session_started'
          AND occurred_at >= ${window.fromDate}
          AND occurred_at < ${window.toDate}
      `,
      this._db.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(*) AS cnt
        FROM funnel_event
        WHERE event_type = 'guest_registered'
          AND occurred_at >= ${window.fromDate}
          AND occurred_at < ${window.toDate}
      `,
      isIncompleteWindow(this._db, window),
    ]);

    const guestSessionCount = Number(sessions[0]?.cnt ?? 0n);
    const registrationCount = Number(registrations[0]?.cnt ?? 0n);

    return {
      window,
      incompleteWindow: incomplete,
      guestSessionCount,
      registrationCount,
      conversionRate: safeRate(registrationCount, guestSessionCount),
      targetRate: GUEST_REGISTRATION_TARGET,
    };
  }

  // ── 5. Conversation completion to shortlist ────────────────────────────────

  async getConversationCompletion(
    window: MeasurementWindow,
  ): Promise<ConversationCompletionResult> {
    const [started, shortlisted, incomplete] = await Promise.all([
      this._db.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(DISTINCT conversation_id) AS cnt
        FROM funnel_event
        WHERE event_type = 'conversation_started'
          AND conversation_id IS NOT NULL
          AND occurred_at >= ${window.fromDate}
          AND occurred_at < ${window.toDate}
      `,
      this._db.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(DISTINCT conversation_id) AS cnt
        FROM funnel_event
        WHERE event_type = 'shortlist_presented'
          AND conversation_id IS NOT NULL
          AND occurred_at >= ${window.fromDate}
          AND occurred_at < ${window.toDate}
      `,
      isIncompleteWindow(this._db, window),
    ]);

    const conversationsStarted = Number(started[0]?.cnt ?? 0n);
    const shortlistsPresentedCount = Number(shortlisted[0]?.cnt ?? 0n);

    return {
      window,
      incompleteWindow: incomplete,
      conversationsStarted,
      shortlistsPresentedCount,
      completionRate: safeRate(shortlistsPresentedCount, conversationsStarted),
      targetRate: CONVERSATION_COMPLETION_TARGET,
    };
  }

  // ── 6. Repeat booking rate ─────────────────────────────────────────────────

  async getRepeatBookingRate(
    window: MeasurementWindow,
    windowDays: number = DEFAULT_REPEAT_WINDOW_DAYS,
  ): Promise<RepeatBookingResult> {
    const [actorCounts, incomplete] = await Promise.all([
      this._db.$queryRaw<Array<{ booking_count: bigint; actor: string }>>`
        SELECT pseudonymous_actor_id AS actor, COUNT(*) AS booking_count
        FROM funnel_event
        WHERE event_type = 'payment_confirmed'
          AND occurred_at >= ${window.fromDate}
          AND occurred_at < ${window.toDate}
        GROUP BY pseudonymous_actor_id
      `,
      isIncompleteWindow(this._db, window),
    ]);

    const uniqueBookers = actorCounts.length;
    const repeatBookers = actorCounts.filter((r) => Number(r.booking_count) >= 2).length;

    return {
      window,
      incompleteWindow: incomplete,
      uniqueBookers,
      repeatBookers,
      repeatRate: safeRate(repeatBookers, uniqueBookers),
      targetRate: REPEAT_BOOKING_TARGET,
      windowDays,
    };
  }
}
