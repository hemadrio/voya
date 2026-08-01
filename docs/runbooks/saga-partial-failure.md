# Runbook: Checkout Saga Partial Failure — Compensation Required

**Runbook ID:** RB-024
**Alarms:** `CRITICAL-checkout-fault-rate`, `HIGH-assistant-cap-breach-rate`, `HIGH-assistant-cost-per-booking-warning`, `CRITICAL-assistant-cost-per-booking-ceiling-breach`, `HIGH-assistant-first-token-p95`, `HIGH-assistant-metering-degraded`, `HIGH-assistant-metering-heartbeat-absent`
**Severity:** CRITICAL (unresolved saga legs may leave travelers charged without a confirmed booking)
**SNS Topic:** platform-page
**Owner:** Platform On-Call
**Last reviewed:** 2026-Q3

---

## 1. Severity and blast radius

**Severity:** A checkout saga partial failure occurs when one or more legs of a
multi-service booking (flight + hotel + car) succeed but a later leg fails. The
saga must compensate in reverse commit order: last-committed-first. An
unresolved saga leaves the traveler charged for some legs with an incomplete itinerary.

**Blast radius:**
- Traveler: charged for one or more services that are part of an incomplete booking.
- Itinerary: may be left in a partially-confirmed state.
- Finance: revenue and refund ledgers are inconsistent until compensation completes.
- A confirmed itinerary with an unresolved leg is a data integrity violation (zero-tolerance).

**Compensation invariant:**
- Compensation must execute in last-committed-first order.
- Each compensation step must be idempotent.
- No itinerary may be marked CONFIRMED if any leg is unresolved.

---

## 2. Architecture thresholds (from spec — do not invent new values)

| Parameter | Value |
|-----------|-------|
| Saga commit order | Sequential: flight → hotel → car (or per-itinerary configuration) |
| Compensation order | Last-committed-first (reverse of commit) |
| Compensation idempotency | Each compensation step is idempotent — safe to retry |
| Assistant cost ceiling | Configured in infra/terraform as CRITICAL alarm threshold |
| Checkout fault rate threshold | > 1.0% 5xx over 5 minutes (3 of 5 datapoints) |

---

## 3. Detection signals

```
ALARM: CRITICAL-checkout-fault-rate
Namespace: travel/checkout
Metric:    CheckoutFaultRate (5xx rate)
Threshold: > 1.0% over 5 minutes, 3 of 5 datapoints
```

```
ALARM: CRITICAL-assistant-cost-per-booking-ceiling-breach
Namespace: travel/assistant
Metric:    AssistantCostPerBooking
Threshold: > ceiling value (from Terraform locals.tf)
```

**What the alarm means:**
- `CRITICAL-checkout-fault-rate`: the checkout journey is producing 5xx errors
  at a rate above the platform fault tolerance. This can indicate a saga
  compensation failure, a booking-service crash, or a supplier rejection.
- `CRITICAL-assistant-cost-per-booking-ceiling-breach`: the AI assistant is
  consuming tokens beyond the per-booking budget ceiling. The governor should
  have halted the conversation; this alarm fires if the governor itself fails.

---

## 4. Triage — start from the reference identifier

**Step 1 — Resolve the reference to an X-Ray trace:**

```bash
ENV=staging
aws xray get-trace-summaries \
  --time-range-type TraceId \
  --filter-expression 'traceId = "<reference>"' \
  --query 'TraceSummaries[0].[Id, ResponseTime, Http.Status]' \
  --output table
```

**Step 2 — Find the saga's commit and compensation events:**

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '2 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, itineraryId, bookingId, sagaStep, sagaState, event
    | filter correlationId = "<reference>"
      OR event like /saga/
    | sort @timestamp asc'
```

**Step 3 — List unresolved saga legs:**

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '2 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, itineraryId, sagaStep, sagaState
    | filter event = "saga.leg.unresolved"
    | sort @timestamp desc
    | limit 20'
```

**Step 4 — Confirm no itinerary is CONFIRMED with an unresolved leg:**

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '2 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, itineraryId, itineraryStatus, unresolvedLegCount
    | filter event = "saga.integrity.check"
      AND itineraryStatus = "CONFIRMED"
      AND unresolvedLegCount > 0'
```

**Fallback (trace older than X-Ray retention window):**
Query CloudWatch Logs Insights on `/ecs/${ENV}/booking-service` with
`$.correlationId = "<reference>"` over an extended time range.

---

## 5. Decision tree

```
Saga partial failure detected
  └─ Are all compensation steps complete?
       ├─ YES → Post-compensation cleanup:
       │    ├─ Verify refunds issued for each compensated leg
       │    └─ Notify traveler; close incident
       └─ NO → Which legs are unresolved?
            ├─ A CONFIRMED leg needs compensation →
            │    Execute compensation in last-committed-first order (Step 6.2)
            └─ A compensation step is failing →
                 └─ Is it idempotent-safe to retry?
                      ├─ YES → Retry (Step 6.3)
                      └─ NO  → Manual supplier cancellation required; escalate (Section 8)
```

---

## 6. Remediation steps

### Step 1 — Confirm the saga state and unresolved legs

```bash
# Pull the full saga event history for the affected itinerary
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '24 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, sagaStep, sagaState, bookingId, outcome
    | filter itineraryId = "<itinerary-id>"
    | sort @timestamp asc'
```

### Step 2 — Trigger compensation (last-committed-first order)

Compensation is triggered through the internal saga compensation endpoint (not
a public API). The booking-service saga coordinator handles compensation
sequencing. If compensation did not auto-trigger, force it:

```bash
# Force compensation via the internal admin API (staging only without Head of Engineering approval)
# Reference the internal admin API documentation in the engineering Notion (not reproduced here)
# The saga coordinator will execute compensation in last-committed-first order automatically.
echo "Trigger saga.compensation.force for itinerary ${ITINERARY_ID} via internal admin API"
```

Each compensation step is idempotent — triggering compensation more than once
is safe and will not create duplicate refunds.

### Step 3 — Verify refund routing for each compensated leg

For each compensated leg, the saga coordinator should have routed a refund
through Stripe (for payment-confirmed legs). Verify:

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/payment-service" \
  --start-time $(date -d '2 hours ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, bookingId, refundId, refundAmount, outcome
    | filter event = "refund.issued" OR event = "refund.failed"
    | filter itineraryId = "<itinerary-id>"
    | sort @timestamp asc'
```

### Step 4 — Confirm no confirmed itinerary has unresolved legs

```bash
# This is the zero-tolerance check — run after all compensation is complete
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date +%s) \
  --end-time $(date -d '+1 minute' +%s) \
  --query-string 'fields @timestamp, itineraryId, itineraryStatus, unresolvedLegCount
    | filter event = "saga.integrity.check"
      AND itineraryStatus = "CONFIRMED"
      AND unresolvedLegCount > 0'
```

Expected: no results. A confirmed itinerary with unresolved legs is a data
integrity violation requiring immediate Head of Engineering escalation.

### Step 5 — Verify the alarm cleared

```bash
aws cloudwatch describe-alarms \
  --alarm-names "CRITICAL-checkout-fault-rate" \
  --query 'MetricAlarms[0].StateValue' \
  --output text
```

---

## 7. Verification

- [ ] `CRITICAL-checkout-fault-rate` → `OK`
- [ ] All saga legs for the affected itinerary are either CONFIRMED or COMPENSATED
- [ ] No CONFIRMED itinerary has `unresolvedLegCount > 0`
- [ ] Refunds issued for all compensated legs (verify via Stripe Dashboard: no card data in logs)
- [ ] Traveler notified of the compensation outcome
- [ ] Booking service health endpoint: `GET /health` → `200 { "status": "ok" }`

---

## 8. Rollback

```bash
# If a code regression introduced the partial-failure condition
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-booking-service" \
  --task-definition "${ENV}-booking-service:<PREVIOUS_REVISION>" \
  --force-new-deployment

aws ecs wait services-stable \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-booking-service"
```

**Rollback target:** previous immutable task definition revision (n-1).
**Time to recover:** under 5 minutes via the previous task definition revision procedure.

> **Note:** rolling back does not undo saga state in the database. Compensation
> for any in-flight sagas at the time of rollback must still be completed manually.

---

## 9. Escalation contacts

| Trigger | Contact | Channel | SLA |
|---------|---------|---------|-----|
| Saga partial failure detected | Platform On-Call | PagerDuty | Immediate |
| Compensation step failing | Head of Engineering | `#incidents` + direct page | 15 min |
| CONFIRMED itinerary with unresolved legs | Head of Engineering + Finance | `#incidents` | Immediate |
| Refund routing failure | Finance | `#incidents` | 15 min |
| Assistant cost ceiling breach | Head of Product + Finance | `#incidents` | 30 min |

---

## 10. Post-incident evidence capture (SOC 2)

1. Export the full saga event history for all affected itinerary IDs.
2. Export the compensation and refund log lines from booking-service and payment-service.
3. Record: itinerary IDs, affected legs, compensation steps taken, refunds issued (reference IDs only — no card data).
4. Record the integrity-check result (confirming no CONFIRMED itinerary has unresolved legs).
5. Archive to `s3://travel-platform-soc2-evidence/incidents/<YYYYMMDD>-saga-compensation/`.
6. File a post-mortem for every saga partial failure event — these are zero-tolerance incidents.
