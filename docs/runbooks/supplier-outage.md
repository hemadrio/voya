# Runbook: Supplier Outage and Circuit Breaker Open

**Runbook ID:** RB-020
**Alarms:** `HIGH-search-supplier-breaker-open`, `CRITICAL-search-fault-rate`, `CRITICAL-search-latency-p95-by-category-hard`, `HIGH-search-latency-p95-by-category-warning`, `search-response-p95`, `booking-insert-latency-p95`
**Severity:** HIGH → CRITICAL if all suppliers fail simultaneously
**SNS Topic:** platform-page (CRITICAL), platform-ticket (HIGH)
**Owner:** Platform On-Call
**Last reviewed:** 2026-Q3

---

## 1. Severity and blast radius

**Severity:** A supplier outage opens the circuit breaker for that supplier's category. Affected travelers receive results from remaining suppliers only, or — if all suppliers fail — an empty-state response with alternative-date suggestions.

**Blast radius:**
- Travelers searching the affected category receive partial results or an empty state with `illustrative: false` alternatives.
- No booking is possible against a supplier in OPEN breaker state; the offer is marked non-bookable.
- If all suppliers for a category fail simultaneously, the empty-state path is served — no error page.
- Revenue impact: lost bookings proportional to market-share of failed supplier.
- No impact on already-confirmed bookings or existing itineraries.

---

## 2. Architecture thresholds (from spec — do not invent new values)

| Parameter | Value |
|-----------|-------|
| Breaker trip threshold | 5 failures in a 10-second rolling window |
| Breaker state: OPEN hold time | 30 seconds (half-open probe interval) |
| Supplier call timeout (healthy) | 2,200 ms |
| Supplier call timeout (degraded, Redis absent) | 1,500 ms |
| Half-open probe: success → CLOSED | 1 successful response |
| Half-open probe: failure → OPEN again | Re-opens for another 30 seconds |

---

## 3. Detection signals

```
ALARM: HIGH-search-supplier-breaker-open
Namespace: travel/search
Metric:    SupplierBreakerTransitionsTotal
Threshold: any transition to OPEN state within 5 minutes
```

```
ALARM: CRITICAL-search-fault-rate
Namespace: travel/search
Metric:    SearchFaultRate
Threshold: > 1% over 5 minutes (3 of 5 datapoints)
```

```
ALARM: CRITICAL-search-latency-p95-by-category-hard
Namespace: travel/search
Metric:    SearchResponseP95 (per-category dimension)
Threshold: p95 > 5,000 ms, 3 of 5 datapoints at 1-minute periods
```

**What the alarm means:** A supplier has failed repeatedly within the rolling window, causing the CircuitBreaker to enter OPEN state. Requests to that supplier are short-circuited and the remaining supplier pool is used. If the fault rate alarm fires concurrently, the partial-results path has degraded to empty-state.

---

## 4. Triage — start from the reference identifier

**Step 1 — Resolve the reference to an X-Ray trace:**

```bash
ENV=staging   # or production
aws xray get-trace-summaries \
  --time-range-type TraceId \
  --filter-expression 'traceId = "<reference>"' \
  --query 'TraceSummaries[0].[Id, ResponseTime, Http.Status]' \
  --output table
```

**Step 2 — Filter correlated log lines for the affected search request:**

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '30 minutes ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, level, supplier, event, errorCode, durationMs
    | filter correlationId = "<reference>"
    | filter event like /supplier|circuit|breaker/
    | sort @timestamp asc'
```

**Step 3 — Identify the failing supplier and breaker state:**

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '30 minutes ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, supplier, event, breakerState
    | filter event = "circuit_breaker.state_change"
    | sort @timestamp desc
    | limit 20'
```

**Step 4 — Check per-category p95 latency on the dashboard:**
- Dashboard: `{environment}-search-supplier-health`
- Widget: "Supplier Breaker Transitions", "Per-category Search Latency"

**Fallback (trace older than X-Ray retention window):**
Query CloudWatch Logs Insights on `/ecs/${ENV}/booking-service` with
`$.correlationId = "<reference>"` over an extended time range.

---

## 5. Decision tree

```
HIGH-search-supplier-breaker-open fires
  └─ Is only one supplier affected, or multiple?
       ├─ ONE supplier → partial-results path is active
       │    └─ Are bookings still completing on remaining suppliers? (check
       │       booking-service health endpoint)
       │         ├─ YES → monitor for half-open recovery (30 s probe cycle)
       │         │         → if not recovering after 5 min, proceed to Step 5.2
       │         └─ NO  → CRITICAL: escalate to Head of Engineering immediately
       └─ ALL suppliers for a category → empty-state path active
            └─ Is the CRITICAL-search-fault-rate alarm also firing?
                 ├─ YES → full supplier outage — escalate per Section 8
                 └─ NO  → brief transient, wait for half-open recovery
```

---

## 6. Remediation steps

### Step 1 — Confirm breaker state and affected supplier

```bash
# Query structured logs for current breaker state
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '5 minutes ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, supplier, breakerState, failureCount, windowMs
    | filter event = "circuit_breaker.state_change"
      OR event = "circuit_breaker.probe"
    | sort @timestamp desc
    | limit 10'
```

### Step 2 — Verify the stale-cache path is active (if Redis is healthy)

The cache serves the previous successful response with `stale: true` in the
response envelope. Confirm travelers are receiving labelled stale results:

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '15 minutes ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, cacheStatus, staleFreshnessLabel
    | filter event = "search.cache.stale_serve"
    | stats count() by bin(1m)'
```

### Step 3 — Wait for half-open probe and automatic recovery

The circuit breaker probes the supplier every 30 seconds (half-open probe interval).
If the supplier recovers, the breaker transitions to CLOSED automatically — no
manual intervention is needed under normal conditions.

Monitor the breaker state log stream. Recovery typically takes 1–3 probe cycles
(30–90 seconds) after the supplier recovers.

### Step 4 — If the supplier is not recovering after 5 minutes: notify supplier

Contact the supplier's on-call technical team via the contact details in the
engineering Notion page "Supplier SLAs and Contacts" (not reproduced here — no
credentials in runbooks).

### Step 5 — If the supplier is confirmed down and booking impact is severe

Consider routing the affected category to the empty-state alternative-date path
by setting the supplier's weight to 0 in the supplier configuration:

```bash
# This is a configuration parameter, not a code change.
# Update the supplier weight via the internal admin API (staging: read-only until
# reviewed by Head of Engineering for production).
# Reference the deploy-and-rollback.md runbook for the configuration update procedure.
```

### Step 6 — Verify the alarm cleared

```bash
aws cloudwatch describe-alarms \
  --alarm-names "HIGH-search-supplier-breaker-open" "CRITICAL-search-fault-rate" \
  --query 'MetricAlarms[*].{Name:AlarmName,State:StateValue}' \
  --output table
```

---

## 7. Verification

- [ ] `HIGH-search-supplier-breaker-open` → `OK`
- [ ] `CRITICAL-search-fault-rate` → `OK` (or `INSUFFICIENT_DATA` if traffic is low)
- [ ] Search endpoint returns results with `illustrative: false` for the affected category
- [ ] Booking service health endpoint: `GET /health` → `200 { "status": "ok" }`
- [ ] No new `circuit_breaker.state_change` events with `state: OPEN` for 5 minutes

---

## 8. Rollback

```bash
# Roll back booking-service to the previous task definition revision
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

---

## 9. Escalation contacts

| Trigger | Contact | Channel | SLA |
|---------|---------|---------|-----|
| Single supplier down > 10 min | Platform On-Call | PagerDuty | Immediate |
| All suppliers for a category down | Head of Engineering | `#incidents` + direct page | Immediate |
| Suspected supplier DDoS or abuse | Security Lead | `#security-incidents` | Immediate |
| Revenue impact > £10k estimated | Finance + Head of Product | `#incidents` | 30 min |

---

## 10. Post-incident evidence capture (SOC 2)

1. Export the breaker transition log for the alarm window from `/ecs/${ENV}/booking-service`.
2. Export the X-Ray traces for affected search requests.
3. Record in the incident ticket: which supplier, duration of outage, traveler impact estimate (counts only, no PII), and supplier contact record.
4. Archive to `s3://travel-platform-soc2-evidence/incidents/<YYYYMMDD>-supplier-outage/`.
5. File a post-mortem if impact lasted > 15 minutes or > 50 affected travelers.
