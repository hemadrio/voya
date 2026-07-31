/**
 * Domain-specific span attribute helpers for @travel services.
 *
 * Each function writes attributes to the currently active span and is safe
 * to call when no span is active — attributes are silently dropped.
 *
 * PII policy: none of these helpers accept or record email addresses, dates of
 * birth, passport numbers, card data, or secret values.  Booking IDs are
 * platform-generated UUIDs and are not PII.
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Attribute key constants (travel domain namespace)
// ---------------------------------------------------------------------------

const ATTR_SUPPLIER_NAME = 'travel.supplier.name';
const ATTR_SUPPLIER_OUTCOME = 'travel.supplier.outcome';
const ATTR_SUPPLIER_DURATION_MS = 'travel.supplier.duration_ms';
const ATTR_BOOKING_ID = 'travel.booking.id';
const ATTR_BOOKING_FROM_STATE = 'travel.booking.from_state';
const ATTR_BOOKING_TO_STATE = 'travel.booking.to_state';
const ATTR_AI_REMAINING_TOKENS = 'travel.ai.remaining_tokens';
const ATTR_AI_REMAINING_TOOL_CALLS = 'travel.ai.remaining_tool_calls';
const ATTR_AI_BUDGET_CAP_HIT = 'travel.ai.budget_cap_hit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupplierOutcome =
  | 'success'
  | 'timeout'
  | 'rejected'
  | 'unavailable'
  | 'partial';

export type BookingState =
  | 'PENDING'
  | 'AWAITING_PAYMENT'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'EXPIRED';

// ---------------------------------------------------------------------------
// recordSupplierCall — for search spans
// ---------------------------------------------------------------------------

/**
 * Record a supplier call outcome on the active span.
 *
 * Sets span status to ERROR for non-recoverable outcomes (timeout, rejected,
 * unavailable) so the ErrorAndSlowSpanProcessor promotes the trace for export
 * even when the trace was not head-sampled.
 */
export function recordSupplierCall(
  name: string,
  outcome: SupplierOutcome,
  durationMs: number,
): void {
  const span = trace.getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR_SUPPLIER_NAME, name);
  span.setAttribute(ATTR_SUPPLIER_OUTCOME, outcome);
  span.setAttribute(ATTR_SUPPLIER_DURATION_MS, durationMs);

  if (outcome === 'timeout' || outcome === 'rejected' || outcome === 'unavailable') {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Supplier ${name}: ${outcome}`,
    });
  }
}

// ---------------------------------------------------------------------------
// recordBookingTransition — for checkout spans
// ---------------------------------------------------------------------------

/**
 * Record a booking lifecycle transition on the active span.
 *
 * bookingId is a platform-generated UUID — not PII.  Traveler identity must
 * never be passed as bookingId or any other attribute here.
 */
export function recordBookingTransition(
  bookingId: string,
  fromState: BookingState,
  toState: BookingState,
): void {
  const span = trace.getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR_BOOKING_ID, bookingId);
  span.setAttribute(ATTR_BOOKING_FROM_STATE, fromState);
  span.setAttribute(ATTR_BOOKING_TO_STATE, toState);
}

// ---------------------------------------------------------------------------
// recordAssistantBudget — for conversation spans
// ---------------------------------------------------------------------------

/**
 * Record the remaining AI assistant token / tool-call budget on the active span.
 *
 * Sets travel.ai.budget_cap_hit=true when either budget is exhausted, which
 * triggers the ErrorAndSlowSpanProcessor's always-export policy so operators
 * can observe budget exhaustion in X-Ray without relying on head sampling.
 *
 * Long-lived conversations must cap child spans externally; when the cap is
 * hit, call this helper once with remainingToolCalls=0 to signal it.
 */
export function recordAssistantBudget(
  remainingTokens: number,
  remainingToolCalls: number,
): void {
  const span = trace.getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR_AI_REMAINING_TOKENS, remainingTokens);
  span.setAttribute(ATTR_AI_REMAINING_TOOL_CALLS, remainingToolCalls);

  if (remainingTokens <= 0 || remainingToolCalls <= 0) {
    span.setAttribute(ATTR_AI_BUDGET_CAP_HIT, true);
  }
}
