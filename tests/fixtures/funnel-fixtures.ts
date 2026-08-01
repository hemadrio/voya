/**
 * Synthetic funnel event fixtures (WO-106 AC12).
 *
 * 200+ deterministic events spanning multiple cohorts and categories for
 * testing reporting queries without external dependencies.
 *
 * Cohorts:
 *   A — 80 actors, search→book→pay conversion, some with assistant
 *   B — 40 actors, search only (no booking) — dilutes conversion rate
 *   C — 20 actors, multi-category itineraries (flight + hotel)
 *   D — 10 actors, guest→register
 *   E — 10 repeat bookers (2+ payments in the 180-day window)
 *
 * No PII: pseudonymousActorId values are deterministic hex strings.
 * All dates are within the measurement window [WINDOW_START, WINDOW_END).
 */

export const WINDOW_START = new Date("2026-01-01T00:00:00.000Z");
export const WINDOW_END = new Date("2026-04-01T00:00:00.000Z");
export const OUTSIDE_WINDOW_DATE = new Date("2025-12-01T00:00:00.000Z");
export const FUNNEL_TEST_KEY = "test-pseudonym-key-32chars-padded!!";

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

let _seq = 0;
function seq(): string {
  return String(++_seq).padStart(6, "0");
}

function isoDate(base: Date, offsetDays: number): string {
  return new Date(base.getTime() + offsetDays * 86_400_000).toISOString();
}

function pseudoActor(index: number): string {
  return ("0".repeat(63) + String(index)).slice(-64);
}

type EventType =
  | "session_started" | "search_performed" | "results_viewed"
  | "offer_selected" | "itinerary_created" | "booking_created"
  | "payment_confirmed" | "conversation_started" | "shortlist_presented"
  | "conversation_handoff" | "guest_registered" | "preference_saved";

type Category = "FLIGHT" | "HOTEL" | "CAR" | "MULTI" | "ASSISTANT" | "AUTH" | "UNKNOWN";

interface FixtureEvent {
  id: string;
  schemaVersion: number;
  eventType: EventType;
  occurredAt: string;
  correlationId: string;
  pseudonymousActorId: string;
  sessionId: string;
  conversationId?: string;
  itineraryId?: string;
  bookingId?: string;
  category: Category;
  attributes: Record<string, string | number | boolean>;
  purgeAfter: string;
}

function makeFixture(
  overrides: Partial<FixtureEvent> & Pick<FixtureEvent, "eventType" | "pseudonymousActorId">,
): FixtureEvent {
  const id = `fix-${seq()}`;
  const purgeAfter = new Date(
    new Date(overrides.occurredAt ?? WINDOW_START.toISOString()).getTime() +
    400 * 86_400_000,
  ).toISOString();

  return {
    id,
    schemaVersion: 1,
    occurredAt: isoDate(WINDOW_START, 1),
    correlationId: `corr-${id}`,
    sessionId: `sess-${overrides.pseudonymousActorId.slice(0, 8)}`,
    category: "FLIGHT",
    attributes: {},
    purgeAfter,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cohort A: 80 actors who search AND book AND pay (some with assistant)
// ---------------------------------------------------------------------------

const COHORT_A_SIZE = 80;
const cohortAEvents: FixtureEvent[] = [];

for (let i = 1; i <= COHORT_A_SIZE; i++) {
  const actor = pseudoActor(i);
  const sessId = `sess-a-${i}`;
  const itinId = `itin-a-${i}`;
  const bookId = `book-a-${i}`;
  const offsetDays = i % 85; // spread across the window
  const hasAssistant = i % 5 === 0; // every 5th actor used assistant
  const convId = hasAssistant ? `conv-a-${i}` : undefined;

  cohortAEvents.push(
    makeFixture({ eventType: "search_performed", pseudonymousActorId: actor, sessionId: sessId, category: "FLIGHT", occurredAt: isoDate(WINDOW_START, offsetDays) }),
    makeFixture({ eventType: "results_viewed", pseudonymousActorId: actor, sessionId: sessId, category: "FLIGHT", occurredAt: isoDate(WINDOW_START, offsetDays) }),
    makeFixture({ eventType: "offer_selected", pseudonymousActorId: actor, sessionId: sessId, itineraryId: itinId, category: "FLIGHT", conversationId: convId, occurredAt: isoDate(WINDOW_START, offsetDays + 1) }),
    makeFixture({ eventType: "itinerary_created", pseudonymousActorId: actor, sessionId: sessId, itineraryId: itinId, category: "FLIGHT", conversationId: convId, occurredAt: isoDate(WINDOW_START, offsetDays + 1) }),
    makeFixture({ eventType: "booking_created", pseudonymousActorId: actor, sessionId: sessId, bookingId: bookId, itineraryId: itinId, category: "FLIGHT", conversationId: convId, occurredAt: isoDate(WINDOW_START, offsetDays + 2) }),
    makeFixture({ eventType: "payment_confirmed", pseudonymousActorId: actor, sessionId: sessId, bookingId: bookId, itineraryId: itinId, category: "FLIGHT", conversationId: convId, occurredAt: isoDate(WINDOW_START, offsetDays + 3) }),
  );

  if (hasAssistant && convId) {
    cohortAEvents.push(
      makeFixture({ eventType: "conversation_started", pseudonymousActorId: actor, sessionId: sessId, conversationId: convId, category: "ASSISTANT", occurredAt: isoDate(WINDOW_START, offsetDays) }),
      makeFixture({ eventType: "shortlist_presented", pseudonymousActorId: actor, sessionId: sessId, conversationId: convId, category: "ASSISTANT", occurredAt: isoDate(WINDOW_START, offsetDays + 1) }),
    );
  }
}

// ---------------------------------------------------------------------------
// Cohort B: 40 actors who search but do NOT book
// ---------------------------------------------------------------------------

const COHORT_B_SIZE = 40;
const cohortBEvents: FixtureEvent[] = [];

for (let i = COHORT_A_SIZE + 1; i <= COHORT_A_SIZE + COHORT_B_SIZE; i++) {
  const actor = pseudoActor(i);
  const sessId = `sess-b-${i}`;
  const offsetDays = i % 85;

  cohortBEvents.push(
    makeFixture({ eventType: "search_performed", pseudonymousActorId: actor, sessionId: sessId, category: "HOTEL", occurredAt: isoDate(WINDOW_START, offsetDays) }),
    makeFixture({ eventType: "results_viewed", pseudonymousActorId: actor, sessionId: sessId, category: "HOTEL", occurredAt: isoDate(WINDOW_START, offsetDays) }),
  );
}

// ---------------------------------------------------------------------------
// Cohort C: 20 actors with multi-category itineraries (FLIGHT + HOTEL)
// ---------------------------------------------------------------------------

const COHORT_C_START = COHORT_A_SIZE + COHORT_B_SIZE + 1;
const COHORT_C_SIZE = 20;
const cohortCEvents: FixtureEvent[] = [];

for (let i = COHORT_C_START; i < COHORT_C_START + COHORT_C_SIZE; i++) {
  const actor = pseudoActor(i);
  const sessId = `sess-c-${i}`;
  const itinId = `itin-c-${i}`;
  const bookId1 = `book-c-${i}-flight`;
  const bookId2 = `book-c-${i}-hotel`;
  const offsetDays = i % 85;

  cohortCEvents.push(
    makeFixture({ eventType: "offer_selected", pseudonymousActorId: actor, sessionId: sessId, itineraryId: itinId, category: "FLIGHT", occurredAt: isoDate(WINDOW_START, offsetDays) }),
    makeFixture({ eventType: "offer_selected", pseudonymousActorId: actor, sessionId: sessId, itineraryId: itinId, category: "HOTEL", occurredAt: isoDate(WINDOW_START, offsetDays) }),
    makeFixture({ eventType: "itinerary_created", pseudonymousActorId: actor, sessionId: sessId, itineraryId: itinId, category: "MULTI", occurredAt: isoDate(WINDOW_START, offsetDays + 1) }),
    makeFixture({ eventType: "booking_created", pseudonymousActorId: actor, sessionId: sessId, bookingId: bookId1, itineraryId: itinId, category: "FLIGHT", occurredAt: isoDate(WINDOW_START, offsetDays + 2) }),
    makeFixture({ eventType: "booking_created", pseudonymousActorId: actor, sessionId: sessId, bookingId: bookId2, itineraryId: itinId, category: "HOTEL", occurredAt: isoDate(WINDOW_START, offsetDays + 2) }),
    makeFixture({ eventType: "payment_confirmed", pseudonymousActorId: actor, sessionId: sessId, bookingId: bookId1, itineraryId: itinId, category: "FLIGHT", occurredAt: isoDate(WINDOW_START, offsetDays + 3) }),
  );
}

// ---------------------------------------------------------------------------
// Cohort D: 10 actors who register from a guest session
// ---------------------------------------------------------------------------

const COHORT_D_START = COHORT_C_START + COHORT_C_SIZE;
const COHORT_D_SIZE = 10;
const cohortDEvents: FixtureEvent[] = [];

for (let i = COHORT_D_START; i < COHORT_D_START + COHORT_D_SIZE; i++) {
  const actor = pseudoActor(i);
  const sessId = `sess-d-${i}`;
  const offsetDays = i % 60;

  cohortDEvents.push(
    makeFixture({ eventType: "session_started", pseudonymousActorId: actor, sessionId: sessId, category: "AUTH", attributes: { isAnonymous: true }, occurredAt: isoDate(WINDOW_START, offsetDays) }),
    makeFixture({ eventType: "guest_registered", pseudonymousActorId: actor, sessionId: sessId, category: "AUTH", occurredAt: isoDate(WINDOW_START, offsetDays + 1) }),
  );
}

// ---------------------------------------------------------------------------
// Cohort E: 10 repeat bookers (2 payments each within window)
// ---------------------------------------------------------------------------

const COHORT_E_START = COHORT_D_START + COHORT_D_SIZE;
const COHORT_E_SIZE = 10;
const cohortEEvents: FixtureEvent[] = [];

for (let i = COHORT_E_START; i < COHORT_E_START + COHORT_E_SIZE; i++) {
  const actor = pseudoActor(i);
  const sessId = `sess-e-${i}`;
  const bookId1 = `book-e-${i}-1`;
  const bookId2 = `book-e-${i}-2`;

  cohortEEvents.push(
    makeFixture({ eventType: "payment_confirmed", pseudonymousActorId: actor, sessionId: sessId, bookingId: bookId1, category: "FLIGHT", occurredAt: isoDate(WINDOW_START, 10) }),
    makeFixture({ eventType: "payment_confirmed", pseudonymousActorId: actor, sessionId: sessId, bookingId: bookId2, category: "HOTEL", occurredAt: isoDate(WINDOW_START, 50) }),
  );
}

// ---------------------------------------------------------------------------
// One event outside the window (for boundary testing)
// ---------------------------------------------------------------------------

const outsideWindowEvent = makeFixture({
  eventType: "search_performed",
  pseudonymousActorId: pseudoActor(999),
  occurredAt: OUTSIDE_WINDOW_DATE.toISOString(),
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ALL_FUNNEL_FIXTURES: FixtureEvent[] = [
  ...cohortAEvents,
  ...cohortBEvents,
  ...cohortCEvents,
  ...cohortDEvents,
  ...cohortEEvents,
  outsideWindowEvent,
];

// Counts for test assertions
export const FIXTURE_STATS = {
  totalEvents: ALL_FUNNEL_FIXTURES.length,
  searchPerformedCount: ALL_FUNNEL_FIXTURES.filter((e) => e.eventType === "search_performed").length,
  bookingCreatedCount: ALL_FUNNEL_FIXTURES.filter((e) => e.eventType === "booking_created").length,
  paymentConfirmedCount: ALL_FUNNEL_FIXTURES.filter((e) => e.eventType === "payment_confirmed").length,
  guestRegisteredCount: ALL_FUNNEL_FIXTURES.filter((e) => e.eventType === "guest_registered").length,
  conversationStartedCount: ALL_FUNNEL_FIXTURES.filter((e) => e.eventType === "conversation_started").length,
  shortlistPresentedCount: ALL_FUNNEL_FIXTURES.filter((e) => e.eventType === "shortlist_presented").length,
  cohortASize: COHORT_A_SIZE,
  cohortBSize: COHORT_B_SIZE,
  cohortCSize: COHORT_C_SIZE,
  cohortDSize: COHORT_D_SIZE,
  cohortESize: COHORT_E_SIZE,
};
