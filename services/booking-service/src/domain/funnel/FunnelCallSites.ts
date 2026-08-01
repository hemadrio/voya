/**
 * Funnel emission call sites for the booking service (WO-106 AC6).
 *
 * Thin helpers that build schema-validated FunnelEvent payloads and forward
 * them to the injected FunnelPort. Every helper returns immediately — callers
 * never await a store write.
 *
 * PII invariant: raw userId is pseudonymised before the event is built; the
 * caller must supply a pre-computed pseudonymousActorId.
 */

import { buildFunnelEvent } from "@travel/contracts";
import type { FunnelPort } from "@travel/observability";

// ---------------------------------------------------------------------------
// Search emission
// ---------------------------------------------------------------------------

export function emitSearchPerformed(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    category: "FLIGHT" | "HOTEL" | "CAR" | "MULTI" | "UNKNOWN";
    resultCount?: number;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "search_performed",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      category: opts.category,
      attributes: opts.resultCount !== undefined
        ? { resultCount: opts.resultCount }
        : {},
    }),
  );
}

export function emitResultsViewed(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    category: "FLIGHT" | "HOTEL" | "CAR" | "MULTI" | "UNKNOWN";
    offersViewed?: number;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "results_viewed",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      category: opts.category,
      attributes: opts.offersViewed !== undefined
        ? { offersViewed: opts.offersViewed }
        : {},
    }),
  );
}

// ---------------------------------------------------------------------------
// Offer selection and itinerary creation
// ---------------------------------------------------------------------------

export function emitOfferSelected(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    itineraryId: string;
    category: "FLIGHT" | "HOTEL" | "CAR" | "MULTI" | "UNKNOWN";
    conversationId?: string;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "offer_selected",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      itineraryId: opts.itineraryId,
      conversationId: opts.conversationId,
      category: opts.category,
      attributes: {},
    }),
  );
}

export function emitItineraryCreated(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    itineraryId: string;
    category: "FLIGHT" | "HOTEL" | "CAR" | "MULTI" | "UNKNOWN";
    conversationId?: string;
    legCount?: number;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "itinerary_created",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      itineraryId: opts.itineraryId,
      conversationId: opts.conversationId,
      category: opts.category,
      attributes: opts.legCount !== undefined ? { legCount: opts.legCount } : {},
    }),
  );
}

// ---------------------------------------------------------------------------
// Booking creation
// ---------------------------------------------------------------------------

export function emitBookingCreated(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    bookingId: string;
    itineraryId?: string;
    category: "FLIGHT" | "HOTEL" | "CAR" | "UNKNOWN";
    conversationId?: string;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "booking_created",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      bookingId: opts.bookingId,
      itineraryId: opts.itineraryId,
      conversationId: opts.conversationId,
      category: opts.category,
      attributes: {},
    }),
  );
}
