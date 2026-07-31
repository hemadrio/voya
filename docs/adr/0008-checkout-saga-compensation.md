# ADR-0008: Checkout Saga: Commit-or-Compensate over Two-Phase Commit

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Platform Engineering, Architecture Review, Security
**Owner:** Platform Engineering

---

## Context

A multi-leg itinerary checkout involves up to three supplier interactions (flight + hotel + car) plus a Stripe PaymentIntent, each of which can fail independently. The platform's business rule BR-01 requires that a booking reaches `CONFIRMED` only on a signature-verified payment notification. BR-02 requires that no leg of an itinerary confirms until every leg resolves — a partial confirmation must not be shown as a complete booking.

The supplier APIs (Amadeus GDS, RapidAPI) offer no distributed-transaction protocol; each supplier accepts or rejects in isolation. Stripe's confirmation path is asynchronous: the booking stays `PENDING` until a webhook arrives. A two-phase commit across these heterogeneous external systems is infeasible.

---

## Decision

The `booking-service` acts as a saga orchestrator using a commit-or-compensate pattern. For each booking:

1. Validate offer provenance and freshness (ProvenanceGuard, OfferFreshnessPolicy).
2. Write a `PENDING` booking with an immutable offer snapshot as JSONB.
3. Create a Stripe PaymentIntent with an idempotency key derived from `bookingId`.
4. Return the `clientSecret` to the browser for Stripe-hosted card entry.
5. On receipt of a signature-verified `payment_intent.succeeded` webhook: transition the booking to `CONFIRMED`, emit a `booking.confirmed` SQS FIFO event, and append an audit row.
6. On receipt of `payment_intent.payment_failed` or after the 30-minute `expiresAt` expiry: transition to `FAILED` or `EXPIRED`, emit a compensation event, and append an audit row.

There is no two-phase commit. The saga is append-only: the `booking_audit_log` table records every state transition with actor, timestamp, previous state, and new state.

---

## Rationale

Suppliers offer no distributed transaction protocol; any cross-supplier coordination must be orchestrated at the application layer. The commit-or-compensate saga is the standard pattern for long-running distributed transactions (Agoda's One Checkout uses exactly this re-sequencing). The webhook-as-sole-confirmation-authority pattern prevents client-confirmed payment — a forgeable signal — from advancing booking state (BR-01). The idempotency key on the PaymentIntent prevents double-charges on client retry (BR-03).

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Two-phase commit across services | Requires all participants to implement 2PC; suppliers provide no prepare/commit protocol; infeasible |
| Client-confirmed payment (browser notifies server on success) | The client confirmation is forgeable; a network interruption after Stripe returns success but before the client notifies the server leaves an orphaned PENDING booking; rejected by BR-01 |
| Choreography-based saga (each service reacts to events) | Harder to trace and debug; a failure mid-saga requires event-sourced reconstruction to determine which legs confirmed; orchestration is simpler at this scale |
| Synchronous supplier hold + release | Suppliers do not offer synchronous hold APIs at the latency budget required; even Amadeus seat hold TTLs are measured in minutes, not milliseconds |

---

## Consequences

**Positive:**
- The saga state is fully observable in the `bookings` and `booking_audit_log` tables at all times.
- The webhook-as-sole-confirmation pattern satisfies BR-01 and prevents client-forgeable confirmations.
- The idempotency key prevents double-charges on Stripe (BR-03).
- Compensation on failure is deterministic: `FAILED` status + audit row + compensation event; the notification consumer handles the user-facing failure notification.

**Negative / Trade-offs:**
- The booking stays `PENDING` until the Stripe webhook arrives (typically <3 s, up to 30 s under load); the UI must handle the `PENDING` → `CONFIRMED` transition gracefully.
- The 30-minute `expiresAt` means a traveler who abandons the card-entry step will see their booking expire; this is by design (offer prices can move significantly in 30 minutes).
- Compensation events must be idempotent: the notification consumer may receive a compensation event more than once if the SQS consumer crashes after processing but before deleting the message.

**Neutral / Notes:**
- The exactly-once idempotency guard on webhook handling is doubly enforced: a Redis `SET NX` on the Stripe event ID (72-hour TTL, covers Stripe's retry horizon) for hot-path deduplication, plus a `processed_event` table with a unique constraint as the durable authority. The DB constraint — not the cache — guarantees exactly-once effect.
- The `ProvenanceGuard` rejects any offer whose provenance is `ILLUSTRATIVE` before the `PENDING` write, making non-bookability a structural property rather than a UI check.

---

## Status History

| Date | Status | Note |
|---|---|---|
| 2026-07-31 | Accepted | Ratified from architecture artifact; Agoda One Checkout research cited |
