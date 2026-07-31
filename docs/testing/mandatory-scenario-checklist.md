# Mandatory Scenario Checklist — High-Risk Branch Coverage

**Version:** 1.0  
**Owners:** Platform Engineering, Security & Quality Engineering  
**Review:** Required at every phase gate exit (Phase 0 → 1, Phase 1 → 2, Phase 2 → GA)

---

## Purpose

This checklist enumerates the high-risk branches and state transitions that must have an
explicit, named unit test. The existence of each test is verified at code review; a
deliberately added `/* v8 ignore */` coverage-escape comment on any of these paths is a
blocking code-review finding.

---

## Booking lifecycle — `services/booking-service/src/domain/`

| # | Scenario | File | Required test name pattern |
|---|---|---|---|
| BK-01 | Booking transition to PENDING from any non-INITIAL state (invalid) | `BookingStateMachine` | `throws LIFECYCLE_CONFLICT when transitioning PENDING → PENDING` |
| BK-02 | Booking confirmation with a non-PENDING status (idempotency guard) | `BookingStateMachine` | `throws LIFECYCLE_CONFLICT when confirming a non-PENDING booking` |
| BK-03 | Cancellation of a CONFIRMED booking after supplier refund eligibility window | `CancellationPolicy` | `throws CANCELLATION_WINDOW_EXPIRED after refund deadline` |
| BK-04 | Cancellation of an already-CANCELLED booking (idempotent path) | `BookingStateMachine` | `returns CANCELLED without error when booking is already cancelled` |
| BK-05 | Illustrative (non-bookable) offer rejected before PENDING creation | `ProvenanceGuard` | ✅ `assertBookable — throws OFFER_NOT_BOOKABLE for ILLUSTRATIVE provenance` |
| BK-06 | Unknown provenance string rejected | `ProvenanceGuard` | ✅ `assertBookable — throws for an unknown provenance` |
| BK-07 | Offer with `bookable=false` rejected regardless of supplier provenance | `ProvenanceGuard` | ✅ `assertBookable — throws for AMADEUS offer with bookable=false` |
| BK-08 | Expiry sweep marks PENDING bookings past `expiresAt` as EXPIRED | `ExpiryPolicy` | `marks PENDING booking as EXPIRED when expiresAt is in the past` |
| BK-09 | Audit log emitted for every valid state transition | `AuditWriter` | ✅ `AuditWriter — writes CREATED row on booking creation` |
| BK-10 | Saga compensation path: FAILED booking after supplier timeout | `BookingSaga` | `sets status FAILED and emits audit row on supplier timeout` |

---

## Payment confirmation — `services/payment-service/src/domain/`

| # | Scenario | File | Required test name pattern |
|---|---|---|---|
| PY-01 | Stripe webhook signature verification failure | `StripeWebhookValidator` | `throws SIGNATURE_VERIFICATION_FAILED when signature does not match` |
| PY-02 | Duplicate payment_intent.succeeded event (exactly-once guard) | `ProcessedEventService` | `returns early without double-applying a duplicate webhook event` |
| PY-03 | Payment confirmation for a non-PENDING booking | `PaymentConfirmationService` | `throws LIFECYCLE_CONFLICT when confirming payment on a non-PENDING booking` |
| PY-04 | Partial refund amount exceeds original charge | `RefundPolicy` | `throws REFUND_AMOUNT_EXCEEDS_CHARGE when partial refund is too large` |
| PY-05 | Saga compensation: payment_intent.payment_failed → booking marked FAILED | `PaymentSaga` | `sets booking status FAILED on payment_intent.payment_failed event` |

---

## Authentication — `services/auth-service/src/domain/`

| # | Scenario | File | Required test name pattern |
|---|---|---|---|
| AU-01 | Password reset with an expired token | `PasswordResetService` | ✅ `resetPassword — throws INVALID_OR_EXPIRED_TOKEN for an expired token` |
| AU-02 | Password reset with an already-consumed token | `PasswordResetService` | ✅ `resetPassword — throws INVALID_OR_EXPIRED_TOKEN for a consumed token` |
| AU-03 | Password reuse rejected during reset | `PasswordResetService` | ✅ `resetPassword — throws PASSWORD_REUSE_NOT_ALLOWED for same password` |
| AU-04 | Session revocation propagates to cache invalidator | `SessionService` | ✅ `logout — calls cacheInvalidator.invalidateSession` |
| AU-05 | logoutAll revokes all sessions for a user | `SessionService` | ✅ `logoutAll — revokes all sessions and calls invalidateUser` |
| AU-06 | Delete session by ID with wrong userId (ownership check) | `SessionService` | ✅ `deleteSession — throws sessionNotFound when session not owned by user` |

---

## Search domain — `services/search-service/src/domain/` *(Phase 1 gate)*

| # | Scenario | File | Required test name pattern |
|---|---|---|---|
| SR-01 | Offer freshness check: STALE offer rejected before booking | `OfferFreshnessPolicy` | `throws OFFER_EXPIRED when offer freshness is STALE` |
| SR-02 | Search cache miss falls through to supplier call | `SearchOrchestrator` | `calls supplier adapter when cache returns null` |
| SR-03 | Supplier timeout → degraded response with cached results | `SearchOrchestrator` | `returns DEGRADED response with last-known results on supplier timeout` |
| SR-04 | Invalid date range (departure before today) rejected at domain layer | `SearchRequestValidator` | `throws VALIDATION_FAILED when departureDate is in the past` |
| SR-05 | Egress policy violation surfaced as EGRESS_DENIED error code | `SupplierGateway` | `throws EGRESS_DENIED when supplier host is not on allow-list` |

---

## Review process

At each phase gate exit the platform engineering lead signs off that:

1. Every ✅ row has a passing named test (verified by `pnpm test:unit --reporter=verbose`).
2. No `/* v8 ignore */` comment covers any row in this checklist.
3. Coverage for all active gated paths is ≥ 60 % lines and branches (verified by `pnpm coverage:check`).
4. The JUnit XML artefact for the release commit is archived in S3 (see `docs/testing/test-strategy.md §Coverage artefact retention`).

New high-risk paths identified during security review or incident post-mortem are added
to this checklist before the next phase gate.
