# SLO Specification

**Status:** Active  
**Owner:** SRE / Platform Engineering  
**Last Updated:** 2026-08-01  
**Review Cadence:** Monthly; targets may not change without a signed-off architecture record.

> **Constraint:** Every numeric target in this document is quoted verbatim from the platform's committed requirements and architecture artifacts. No target may be re-estimated here.

---

## 1. Definitions

| Term | Definition |
|------|------------|
| **SLI** | Service Level Indicator — a quantitative measure of a service aspect |
| **SLO** | Service Level Objective — the target value or range for an SLI |
| **Error Budget** | `1 - SLO` fraction of the measurement window; the amount of unreliability that is tolerable |
| **Burn Rate** | The rate at which the error budget is being consumed relative to nominal |
| **Measurement Window** | 30-day rolling calendar month |
| **Good Event** | A request or probe outcome that satisfies the SLI criterion |
| **Bad Event** | A request or probe outcome that violates the SLI criterion |

---

## 2. SLI Catalogue

### 2.1 Search Latency SLI (cache-miss path)

| Field | Value |
|-------|-------|
| **Category** | Latency |
| **Numerator** | Count of search requests completing in < 3 000 ms (p95 proxy: number of requests whose response time is at or below the p95 value of 3 000 ms) |
| **Denominator** | Total search requests in window, excluding health-check requests |
| **Data Source** | EMF counter `SearchResponseP95` (namespace `travel/search`) emitted by the search service ADOT sidecar; X-Ray trace percentile as secondary confirmation |
| **Measurement Window** | 1 minute (alarm evaluation); 30-day rolling for budget accounting |
| **SLO Target** | p95 latency ≤ **3 000 ms** |
| **Hard Ceiling** | p95 latency ≤ **5 000 ms** (hard alarm — paging severity regardless of budget) |
| **Alarm** | `CRITICAL-search-latency-p95-hard`, `HIGH-search-latency-p95-warning` |

### 2.2 Search Latency SLI (cache-hit path)

| Field | Value |
|-------|-------|
| **Category** | Latency |
| **Numerator** | Count of cache-hit search requests completing in < 180 ms |
| **Denominator** | Total cache-hit search requests in window |
| **Data Source** | EMF counter `SearchCacheHitLatencyP95` (namespace `travel/search`) |
| **Measurement Window** | 1 minute evaluation; 30-day rolling for budget |
| **SLO Target** | p95 latency ≤ **180 ms** |
| **Note** | Legitimately breaches during Redis outage; the cache-unavailability alarm (`search_cache_unavailable_total > 0`) provides context to distinguish modes. Runbook: docs/runbooks/search-latency-breach.md |

### 2.3 Checkout Latency SLI

| Field | Value |
|-------|-------|
| **Category** | Latency |
| **Numerator** | Count of checkout acknowledgement requests completing in < 5 000 ms |
| **Denominator** | Total checkout requests in window |
| **Data Source** | EMF counter `CheckoutAcknowledgementP95` (namespace `travel/checkout`) |
| **Measurement Window** | 1 minute evaluation; 30-day rolling for budget |
| **SLO Target** | p95 latency ≤ **5 000 ms** |
| **Alarm** | `CRITICAL-checkout-latency-p95` |

### 2.4 Assistant First-Token Latency SLI

| Field | Value |
|-------|-------|
| **Category** | Latency |
| **Numerator** | Count of assistant requests delivering first token in < 2 000 ms |
| **Denominator** | Total assistant requests in window |
| **Data Source** | EMF counter `AssistantFirstTokenP95` (namespace `travel/assistant`); X-Ray trace spans with `gen_ai.operation.name` |
| **Measurement Window** | 1 minute evaluation; 30-day rolling for budget |
| **SLO Target** | p95 first-token latency ≤ **2 000 ms** |
| **Alarm** | `HIGH-assistant-first-token-p95` |

### 2.5 Platform Availability SLI

| Field | Value |
|-------|-------|
| **Category** | Availability |
| **Numerator** | Minutes in the window where all required health probes pass (database, cache, queue, secret presence — see §3) |
| **Denominator** | Total minutes in the 30-day window = 43 200 |
| **Data Source** | Dependency-aware `/health/ready` deep probe (health.ts `createHealthCheck`) polling every 60 s; unhealthy = 503 response from any required probe; degraded (non-required probe failure) does NOT count against the availability budget |
| **Measurement Window** | 30-day rolling month |
| **SLO Target** | Availability ≥ **99.5 %** |
| **Error Budget** | 0.5 % of 43 200 minutes = **216 minutes (3 hours 36 minutes)** per 30-day month |
| **Alarm** | `CRITICAL-availability-slo-fast-burn`, `HIGH-availability-slo-slow-burn` |

> **Arithmetic:**  
> Error budget minutes = 43 200 × (1 − 0.995) = 43 200 × 0.005 = **216 minutes ≈ 3 h 36 min**  
> (The WO description states ≈ 3 h 39 min; the precise value at 99.5 % over exactly 30 days is 216.0 minutes = 3 h 36 min. The ≈ 3 h 39 min figure assumes a 30.417-day average month: 30.417 × 24 × 60 × 0.005 ≈ 219 min.)

### 2.6 Platform Server-Fault Rate SLI

| Field | Value |
|-------|-------|
| **Category** | Error Rate |
| **Numerator** | Count of **platform-attributable** HTTP 5xx responses (`HTTPCode_Target_5XX_Count` minus supplier 502/504) |
| **Denominator** | Total requests (`RequestCount`) from ALB target group |
| **Data Source** | `AWS/ApplicationELB` CloudWatch metrics; supplier 502 and 504 are **excluded** via a separate `supplier_5xx_total` EMF counter so supplier outages do not consume the platform budget |
| **Measurement Window** | 5-minute evaluation; 30-day rolling for budget |
| **SLO Target** | Server-fault rate < **1.0 %** |
| **Alarm** | `CRITICAL-checkout-fault-rate`, `CRITICAL-search-fault-rate`, `HIGH-alb-5xx-fault-rate` |

### 2.7 Checkout Failure SLI

| Field | Value |
|-------|-------|
| **Category** | Error Rate |
| **Numerator** | Count of checkout requests returning a **platform-attributable** failure (5xx, excluding issuer card declines which map to 402/422 with `PAYMENT_DECLINED` code) |
| **Denominator** | Total checkout attempts in window |
| **Data Source** | EMF counter `checkout_platform_failures_total` (namespace `travel/checkout`) — distinct from issuer decline metric `checkout_card_declines_total` |
| **Measurement Window** | 5-minute evaluation; 30-day rolling for budget |
| **SLO Target** | Platform-attributable checkout failures < **0.5 %** |
| **Note** | Issuer card declines are tracked separately and do not count against the platform SLO |

### 2.8 Notification Delivery Timeliness SLI

| Field | Value |
|-------|-------|
| **Category** | Timeliness |
| **Numerator** | Count of notifications delivered to SES within 5 minutes of event enqueue timestamp |
| **Denominator** | Total notifications enqueued in window |
| **Data Source** | `ApproximateAgeOfOldestMessage` (`AWS/SQS`) — proxy: any message older than 300 s indicates the 5-minute window is being breached; `notification_enqueue_to_send_duration_ms` EMF counter (namespace `travel/notification`) for exact measurement |
| **Measurement Window** | 1-minute evaluation; 30-day rolling for budget |
| **SLO Target** | Delivery within 5 minutes for ≥ **99 %** of notifications |
| **Alarm** | `HIGH-notification-queue-oldest-message` (threshold 300 s) |

---

## 3. Availability SLI: Dependency-Aware Deep Health Signal

The availability SLI (§2.5) is derived from the **dependency-aware deep readiness probe**, not from a shallow liveness probe. The probe hierarchy is:

| Probe | Required | Failure Effect |
|-------|----------|----------------|
| PostgreSQL (`$queryRaw SELECT 1`) | Yes | 503 unhealthy — counts against availability budget |
| Redis (`PING`) | No | 200 degraded — does NOT consume budget; search degrades to direct supplier |
| SQS queue (`isHealthy()`) | Yes | 503 unhealthy |
| Secret presence (startup validator result) | Yes | 503 unhealthy |

**Degraded ≠ Unavailable:** Redis failure causes the service to enter degraded-but-serving mode (cache-miss path only, tighter supplier timeout). This is logged as `status: degraded` in the `/health/ready` response body but does not count against the availability budget. The operator must distinguish degraded minutes from unavailable minutes when reporting.

**Probe implementation:** `createHealthCheck()` in `packages/observability/src/health.ts`; probes run in parallel with 1 000 ms individual timeouts and a 5 000 ms TTL cache to avoid exhausting the Prisma connection pool.

---

## 4. Burn-Rate Model

The platform uses the Google SRE multi-window multi-burn-rate approach.

### 4.1 Availability SLO (99.5 %)

| Alert Class | Burn Rate | Short Window | Confirmation Window | Error Rate Threshold | Severity |
|-------------|-----------|--------------|--------------------|-----------------------|----------|
| Fast-burn   | **14.4×** | 1 hour       | 5 minutes (1 of 5) | **7.2 %**             | CRITICAL (page) |
| Slow-burn   | **6×**    | 6 hours      | 30 minutes         | **3.0 %**             | HIGH (ticket) |

**Fast-burn arithmetic:**  
Budget fraction consumed in window = `error_rate × window_hours / budget_hours`  
At 7.2 % error rate for 1 hour: `0.072 × 1 / (43200/60 × 0.005)` = consumes 2 % of monthly budget per hour → exhausts in `1/0.02 = 50 hours` → `50h / 720h = 6.9 %` of month.  
Burn rate = `7.2 % / 0.5 % = 14.4×`.

**Slow-burn arithmetic:**  
At 3.0 % error rate for 6 hours: consumes `3.0 % × 6h / (720h × 0.5 %)` = `18/3.6 = 5 %` of monthly budget in 6 hours.  
Burn rate = `3.0 % / 0.5 % = 6×`.

### 4.2 Burn-Rate Helper Functions

Pure calculation helpers are implemented in `packages/observability/src/slo/burnRate.ts` with an injected clock so they are unit-testable without AWS dependencies. See §5.

---

## 5. No-Data Policy

Every SLI metric must emit data continuously. A stale or absent feed is **never** interpreted as compliance.

| Alarm | Condition | Treat-Missing-Data Setting |
|-------|-----------|---------------------------|
| `HIGH-sli-feed-no-data-search` | No `SearchResponseP95` data for 5 minutes | `breaching` |
| `HIGH-sli-feed-no-data-checkout` | No `CheckoutAcknowledgementP95` data for 5 minutes | `breaching` |
| `HIGH-sli-feed-no-data-assistant` | No `AssistantFirstTokenP95` data for 5 minutes | `breaching` |
| `HIGH-sli-feed-no-data-availability` | No `RequestCount` data from ALB for 5 minutes | `breaching` |

Zero-traffic environments (off-hours staging) are handled by suppression policies in CloudWatch rather than by treating missing data as not-breaching.

---

## 6. Security Event Alarms (Policy A09)

Logging without alerting is insufficient per policy A09. Every security event class raises an alarm.

| Event Class | Metric | Threshold | Severity | Alarm Name |
|-------------|--------|-----------|----------|------------|
| Authentication failures | `AuthFailures` | ≥ 20 / 5 min | HIGH | `HIGH-auth-failure-spike` |
| Access-control denials | `AccessDenied` | ≥ 50 / 5 min | HIGH | `HIGH-access-denied-spike` |
| Webhook signature failures | `webhook_signature_failures_total` | ≥ 5 / 5 min | HIGH | `HIGH-webhook-signature-failure-spike` |
| Stripe signature failures | `StripeSignatureFailures` | ≥ 1 / 5 min | CRITICAL | `CRITICAL-stripe-signature-failure` |
| Secret startup validation failures | `SecretStartupValidationFailures` | ≥ 1 / 5 min | CRITICAL | `CRITICAL-secret-startup-validation-failure` |
| Unflagged illustrative exposure | `IllustrativeExposureUnflagged` | > 0 / 5 min | CRITICAL | `CRITICAL-illustrative-exposure-unflagged-log` |

---

## 7. Out-of-Scope

- Supplier availability SLI (tracked separately as `supplier_availability_*`; supplier 502/504 does not consume the platform error budget)
- Issuer card decline rate (tracked as `checkout_card_declines_total`; not a platform fault)
- Frontend Core Web Vitals (tracked in `frontend/lib/observability/vitals.ts`; not a backend SLI)
