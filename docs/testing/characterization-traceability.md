# Characterization Test Traceability Map

Maps each business rule (BR-01 through BR-05, BR-09 through BR-12) to the
characterization test that pins it at the domain layer and to the downstream
WO-096 / WO-097 integration test that validates it across services.

---

## BR-01 — Booking reaches CONFIRMED only on signature-verified notification

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/payment-service/src/domain/__tests__/webhook-signature.characterization.test.ts` | `WebhookVerifier — valid signature → returns parsed event for a correctly signed webhook` |
| Domain (unit) | `services/payment-service/src/domain/__tests__/webhook-idempotency.characterization.test.ts` | `Webhook idempotency — healthy Redis → processes first delivery and returns PROCESSED` |
| Integration (deferred) | WO-096 | Webhook POST with valid Stripe signature transitions booking to CONFIRMED |

---

## BR-02 — Forged or replayed notifications change nothing and raise a security event

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/payment-service/src/domain/__tests__/webhook-signature.characterization.test.ts` | `WebhookVerifier — tampered body → throws VALIDATION_FAILED, emits exactly one security event` |
| Domain (unit) | `services/payment-service/src/domain/__tests__/webhook-signature.characterization.test.ts` | `WebhookVerifier — replayed webhook → throws VALIDATION_FAILED for timestamp 1 hour in the past` |
| Domain (unit) | `services/payment-service/src/domain/__tests__/webhook-signature.characterization.test.ts` | `WebhookVerifier — wrong signing secret → emits exactly one security event` |
| Integration (deferred) | WO-096 | Forged webhook POST yields HTTP 400 with no booking state change and a security event row |

---

## BR-03 — Exactly-once booking confirmation

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/payment-service/src/domain/__tests__/webhook-idempotency.characterization.test.ts` | `Webhook idempotency — healthy Redis → three rapid deliveries result in exactly one transition and one notification` |
| Domain (unit) | `services/payment-service/src/domain/__tests__/webhook-idempotency.characterization.test.ts` | `Webhook idempotency — Redis unavailable → second delivery blocked by DB unique constraint` |
| Integration (deferred) | WO-097 | Stripe event delivered three times — booking row shows exactly one CONFIRMED transition |

---

## BR-04 — Append-only audit row for every booking transition

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/booking-service/src/domain/__tests__/booking-lifecycle.characterization.test.ts` | `AuditWriter — append-only writes → writes exactly one row per accepted transition` |
| Domain (unit) | `services/booking-service/src/domain/__tests__/booking-lifecycle.characterization.test.ts` | `AuditWriter — append-only writes → audit client does not expose update or delete operations` |
| Integration (deferred) | WO-096 | Every booking_audit_log row has INSERT timestamp; no UPDATE or DELETE issued against the table |

---

## BR-05 — Disallowed transitions return 409 naming current state and permitted transitions

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/booking-service/src/domain/__tests__/booking-lifecycle.characterization.test.ts` | `BookingStateMachine — forbidden transitions produce 409` (table-driven, all 42 forbidden pairs) |
| Domain (unit) | `services/booking-service/src/domain/__tests__/booking-lifecycle.characterization.test.ts` | `BookingStateMachine — lifecycle conflict on cancelled booking → rejects CONFIRMED transition from CANCELLED state` |
| Integration (deferred) | WO-096 | PATCH /bookings/:id with disallowed status returns 409 with { code: "LIFECYCLE_CONFLICT", permitted: [...] } |

---

## BR-09 — Offer from non-approved provenance is rejected before payment intent creation

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/booking-service/src/domain/__tests__/booking-lifecycle.characterization.test.ts` | `ProvenanceGuard — structural rejection before checkout → rejects ILLUSTRATIVE offer with OFFER_NOT_BOOKABLE (422)` |
| Domain (unit) | `services/booking-service/src/domain/__tests__/booking-lifecycle.characterization.test.ts` | `ProvenanceGuard — structural rejection before checkout → rejects unrecognised provenance string` |
| Domain (unit) | `services/booking-service/src/domain/__tests__/booking-lifecycle.characterization.test.ts` | `ProvenanceGuard — structural rejection before checkout → rejection never fails open` |
| Integration (deferred) | WO-096 | POST /checkout with ILLUSTRATIVE offer returns 422 with no PaymentIntent created |

---

## BR-10 — Checkout saga compensates failed legs; refund instruction for charged legs

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/booking-service/src/domain/__tests__/checkout-saga.characterization.test.ts` | `CheckoutSaga — compensation on failure → compensates all committed legs in reverse order when third leg fails` |
| Domain (unit) | `services/booking-service/src/domain/__tests__/checkout-saga.characterization.test.ts` | `CheckoutSaga — compensation on failure → includes refund instructions only for charged legs` |
| Integration (deferred) | WO-097 | Supplier failure on leg 3 rolls back legs 2 and 1 and enqueues refund for charged amounts |

---

## BR-11 — Per-account login lockout after 5 failures in 15 minutes

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/auth-service/src/domain/__tests__/credentials.characterization.test.ts` | `LoginAttemptGuard — per-account lockout → locks account after 5 failures` |
| Domain (unit) | `services/auth-service/src/domain/__tests__/credentials.characterization.test.ts` | `LoginAttemptGuard — per-account lockout → prevents login when lockedUntil is in the future` |
| Domain (unit) | `services/auth-service/src/domain/__tests__/credentials.characterization.test.ts` | `LoginAttemptGuard — per-account lockout → allows login once lockedUntil has passed` |
| Integration (deferred) | WO-097 | POST /auth/login with 5 consecutive bad passwords returns 429 with Retry-After header |

---

## BR-12 — Cross-account session access returns 403 with security event, no row leaked

| Layer | Test file | Test name |
|-------|-----------|-----------|
| Domain (unit) | `services/auth-service/src/domain/__tests__/session-rotation.characterization.test.ts` | `SessionService.deleteSession → throws SESSION_NOT_FOUND when session does not belong to user (cross-account)` |
| Domain (unit) | `services/auth-service/src/domain/__tests__/session-rotation.characterization.test.ts` | `SessionService.deleteSession → does not disclose the target session's owner on cross-account attempt` |
| Integration (deferred) | WO-097 | DELETE /sessions/:id for another user's session returns 404, emits security event with DENY decision |

---

## Deferred Integration Coverage (WO-096 and WO-097)

The following assertions are out of scope for the domain-layer characterization
tests and are deferred to WO-096 (booking + payment integration) and WO-097
(auth + session integration):

- HTTP status codes and response body shapes (require Express routing)
- Database row assertions (require a real or in-memory Postgres connection)
- Cross-service event propagation (require a message broker)
- Stripe event construction from a real test-mode Stripe account
- End-to-end OIDC flow with state/nonce validation

---

*Generated by WO-095 characterization implementation. Update when new BRs are added.*
