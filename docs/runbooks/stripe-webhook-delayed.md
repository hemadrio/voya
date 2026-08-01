# Runbook: Delayed or Failed Stripe Webhook — Bookings Stuck PENDING

**Runbook ID:** RB-022
**Alarms:** `expiry-sweep-not-running`, `expiry-sweep-high-failure-count`, `expiry-sweep-sustained-backlog`
**Severity:** HIGH (bookings stuck PENDING); escalates to CRITICAL if expiry sweep fails
**SNS Topic:** platform-ticket (HIGH), platform-page (if expiry-sweep-not-running)
**Owner:** Platform On-Call
**Last reviewed:** 2026-Q3

---

## 1. Severity and blast radius

**Severity:** A delayed or dropped Stripe webhook leaves a booking in `PENDING`
state indefinitely. The traveler has been charged but the booking is not confirmed.

**Blast radius:**
- Affected traveler: booking not confirmed; may receive no confirmation email.
- Revenue: payment received but booking status is inconsistent.
- Downstream: itinerary creation may be blocked if the booking is required to be CONFIRMED first.
- The PENDING expiry sweep runs periodically and expires bookings that have been PENDING
  too long — if the sweep fires before the webhook is received, the booking may be expired.

**What maintains exactly-once delivery even when Redis is unavailable:**
- The `processed_events` Postgres table has a unique constraint on `(event_id, event_type)`.
- Replaying a Stripe webhook for the same `event.id` cannot create a second payment record.
- Redis 72-hour idempotency TTL (SET NX) is a performance optimisation, not the authority.

---

## 2. Architecture thresholds (from spec — do not invent new values)

| Parameter | Value |
|-----------|-------|
| Stripe webhook signature tolerance window | 300 seconds (Stripe-imposed) |
| Redis idempotency TTL (webhook dedup SET NX) | 72 hours |
| Processed_events unique constraint | `(event_id, event_type)` — the durable authority |
| PENDING expiry sweep interval | Configured in EventBridge (check deployment) |

---

## 3. Detection signals

```
ALARM: expiry-sweep-not-running
Namespace: travel/booking
Metric:    expiry_sweep_last_run_age_seconds
Threshold: > configured interval (sweep not started on schedule)
```

```
ALARM: expiry-sweep-high-failure-count
Namespace: travel/booking
Metric:    expiry_sweep_failures_total
Threshold: > threshold within evaluation period
```

```
ALARM: expiry-sweep-sustained-backlog
Namespace: travel/booking
Metric:    expiry_sweep_pending_count
Threshold: sustained high backlog of PENDING bookings
```

**What the alarm means:** Bookings are accumulating in PENDING state faster
than the expiry sweep is processing them, OR the expiry sweep itself has failed.
This may be caused by a Stripe webhook delivery failure, a signature mismatch,
or a service crash during webhook processing.

---

## 4. Triage — start from the reference identifier

**Step 1 — Identify bookings stuck PENDING:**

```bash
# Query the booking-service database for recent PENDING bookings
# (run via the booking-service migration or admin tooling — not direct DB access)
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '2 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, bookingId, status, event, correlationId
    | filter status = "PENDING" AND event = "booking.state_stall_detected"
    | sort @timestamp desc
    | limit 20'
```

**Step 2 — Resolve the reference to an X-Ray trace:**

```bash
aws xray get-trace-summaries \
  --time-range-type TraceId \
  --filter-expression 'traceId = "<reference>"' \
  --query 'TraceSummaries[0].[Id, ResponseTime, Http.Status]' \
  --output table
```

**Step 3 — Check Stripe Dashboard for webhook delivery attempts:**

1. Log in to the Stripe Dashboard → Developers → Webhooks → select the endpoint.
2. Click "Webhook attempts" and filter for the affected `payment_intent.succeeded` events.
3. Check: did Stripe send the event? What HTTP status did the endpoint return?
4. If Stripe shows 200 received but the booking is still PENDING: check idempotency guard.
5. If Stripe shows delivery failures: note the event ID and proceed to Step 4.

**Step 4 — Check the processed_events table for the event:**

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/payment-service" \
  --start-time $(date -d '24 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, eventId, eventType, outcome, bookingId
    | filter eventId = "<stripe-event-id>"
    | sort @timestamp asc'
```

**Fallback (trace older than X-Ray retention window):**
Query CloudWatch Logs Insights on `/ecs/${ENV}/payment-service` with the Stripe
event ID: `$.eventId = "<stripe-event-id>"` over an extended time range.

---

## 5. Decision tree

```
Booking stuck PENDING
  └─ Did Stripe successfully deliver the webhook? (Stripe Dashboard)
       ├─ YES (200 from endpoint) →
       │    Was the event processed? (check processed_events log)
       │      ├─ YES → booking service state machine bug; escalate to Head of Engineering
       │      └─ NO  → payment-service processing failure; check service logs (Step 6.2)
       └─ NO (Stripe shows delivery failures) →
            └─ Is the payment-service endpoint reachable?
                 ├─ NO → payment-service is down; escalate immediately (Section 8)
                 └─ YES →
                      └─ Is the signature valid? (no CRITICAL-stripe-signature-failure alarm)
                           ├─ NO  → webhook secret mismatch (stripe-signature-failure.md)
                           └─ YES →
                                └─ Is Redis unavailable?
                                     ├─ YES → Redis dedup bypassed; Postgres constraint is
                                     │        the authority; safe to replay (Step 6.3)
                                     └─ NO  → replay the webhook via Stripe Dashboard (Step 6.3)
```

**Special case — webhook arrives after the PENDING expiry sweep expired the booking:**
If the booking was expired by the sweep before the webhook arrived:
1. The booking cannot be reinstated automatically.
2. Initiate a refund via the Stripe Dashboard for the captured payment.
3. Notify the traveler and Finance (escalation contacts below).
4. A Head of Engineering decision is required before any reinstatement attempt.

---

## 6. Remediation steps

### Step 1 — Confirm expiry sweep health

```bash
# Check the most recent expiry sweep run logs
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '2 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, event, swept, failed, durationMs
    | filter event = "expiry_sweep.complete" OR event = "expiry_sweep.start"
    | sort @timestamp desc
    | limit 10'
```

### Step 2 — Check payment-service logs for processing errors

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/payment-service" \
  --start-time $(date -d '2 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, level, event, errorCode, bookingId
    | filter level = "error" OR level = "warn"
    | sort @timestamp desc
    | limit 50'
```

### Step 3 — Safe webhook replay

**Safety guarantee:** The `processed_events` unique constraint on `(event_id, event_type)`
prevents double-processing regardless of Redis availability. Replaying is always safe.

**Even if Redis is unavailable:** the Postgres constraint is the durable authority.
The Redis SET NX 72-hour TTL is a performance layer, not required for exactly-once.

To replay via the Stripe Dashboard:
1. Stripe Dashboard → Developers → Webhooks → Webhook attempts.
2. Find the failed event.
3. Click "Resend" — Stripe will redeliver the event with the original event ID.

Alternatively, replay using the Stripe CLI (staging only):
```bash
# Staging only — never run against production without Finance approval
stripe events resend <stripe-event-id> --webhook-endpoint <staging-endpoint-id>
```

### Step 4 — Verify the booking was confirmed

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '10 minutes ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, bookingId, event, fromState, toState
    | filter event = "booking.state_transition"
      AND toState = "CONFIRMED"
    | sort @timestamp desc
    | limit 5'
```

### Step 5 — Verify alarms cleared

```bash
aws cloudwatch describe-alarms \
  --alarm-names "expiry-sweep-not-running" "expiry-sweep-high-failure-count" "expiry-sweep-sustained-backlog" \
  --query 'MetricAlarms[*].{Name:AlarmName,State:StateValue}' \
  --output table
```

---

## 7. Verification

- [ ] `expiry-sweep-not-running` → `OK`
- [ ] `expiry-sweep-high-failure-count` → `OK`
- [ ] `expiry-sweep-sustained-backlog` → `OK`
- [ ] Affected booking status → `CONFIRMED` in booking-service logs
- [ ] Stripe Dashboard → webhook event shows successful delivery (200)
- [ ] `processed_events` entry exists for the Stripe event ID (check payment-service logs)
- [ ] No duplicate payment records created (check reconciliation for the booking)

---

## 8. Rollback

```bash
# If a code regression caused payment-service to reject webhooks
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-payment-service" \
  --task-definition "${ENV}-payment-service:<PREVIOUS_REVISION>" \
  --force-new-deployment

aws ecs wait services-stable \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-payment-service"
```

**Rollback target:** previous immutable task definition revision (n-1).
**Time to recover:** under 5 minutes via the previous task definition revision procedure.

---

## 9. Escalation contacts

| Trigger | Contact | Channel | SLA |
|---------|---------|---------|-----|
| Single booking stuck PENDING | Platform On-Call | `#platform-ops` | 30 min |
| Expiry sweep not running | Platform On-Call | PagerDuty | Immediate |
| Booking expired (sweep ran before webhook) | Finance + Head of Engineering | `#incidents` | 15 min |
| Payment received but booking expired | Finance | `#incidents` + Stripe support | Immediate |

---

## 10. Post-incident evidence capture (SOC 2)

1. Export payment-service logs for the affected event IDs from the alarm window.
2. Save Stripe Dashboard delivery attempt screenshots (no card data).
3. Record: event ID, booking ID, duration PENDING, resolution method (replay vs. refund).
4. If a refund was issued: record the Stripe refund ID and notify Finance.
5. Archive to `s3://travel-platform-soc2-evidence/incidents/<YYYYMMDD>-webhook-delayed/`.
6. File a post-mortem if any booking was expired and a refund was required.
