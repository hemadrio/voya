/**
 * Funnel emission call site for the payment service (WO-106).
 *
 * payment_confirmed is emitted after:
 *   1. Stripe webhook signature is verified.
 *   2. Idempotency check (processed_events) confirms this is the first delivery.
 *   3. Booking status transition to CONFIRMED succeeds.
 *
 * Exactly-once guarantee: because this is called only after the idempotency
 * guard, replaying the same Stripe event id cannot produce a second
 * payment_confirmed funnel event (AC6).
 */

import { buildFunnelEvent } from "@travel/contracts";
import type { FunnelPort } from "@travel/observability";

export function emitPaymentConfirmed(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    bookingId: string;
    itineraryId?: string;
    category: "FLIGHT" | "HOTEL" | "CAR" | "UNKNOWN";
    conversationId?: string;
    amountMinorUnits?: number;
    currency?: string;
  },
): void {
  const attributes: Record<string, string | number | boolean> = {};
  if (opts.amountMinorUnits !== undefined) {
    attributes["amountMinorUnits"] = opts.amountMinorUnits;
  }
  if (opts.currency) {
    attributes["currency"] = opts.currency;
  }

  port.emit(
    buildFunnelEvent({
      eventType: "payment_confirmed",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      bookingId: opts.bookingId,
      itineraryId: opts.itineraryId,
      conversationId: opts.conversationId,
      category: opts.category,
      attributes,
    }),
  );
}
