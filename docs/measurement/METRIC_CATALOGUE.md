# Metric Catalogue

Authoritative catalogue of every CloudWatch metric emitted by the travel platform.
Every dashboard widget must reference a namespace + metric_name pair listed here.
The CI step `scripts/validate-dashboard-metrics.ts` fails the build when a widget
references an unlisted metric.

**Adding a metric:** emit it from the owning service/package first, then add a row
here, then reference it in the dashboard module.

---

## travel/funnel — Funnel Telemetry (WO-106)

Emitted by `StdoutEmfWriter` in `packages/observability` via ADOT sidecar.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/funnel` | `funnel_events_total` | eventType, category, environment | Sum | observability/StdoutEmfWriter |
| `travel/funnel` | `funnel_emitter_heartbeat` | environment | Sum | observability/FunnelEmitter |
| `travel/funnel` | `funnel_events_dropped_total` | environment | Sum | observability/FunnelEmitter |
| `travel/funnel` | `funnel_emission_failed_total` | environment | Sum | observability/FunnelEmitter |
| `travel/funnel` | `funnel_validation_failures_total` | environment | Sum | observability/FunnelEmitter |

---

## travel/assistant — Assistant Cost & Latency (WO-107, WO-108)

Emitted by `ai-service` cost metering job and ADOT sidecar.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/assistant` | `assistant_cost_per_completed_booking_usd` | environment, model | Average | ai-service/CostGovernor |
| `travel/assistant` | `assistant_spend_total_usd` | environment, model | Sum | ai-service/CostGovernor |
| `travel/assistant` | `assistant_spend_unattributed_usd` | environment, model | Sum | ai-service/CostGovernor |
| `travel/assistant` | `assistant_cap_breach_count` | environment, model, cap | Sum | ai-service/CostGovernor |
| `travel/assistant` | `assistant_metering_heartbeat` | environment | Sum | ai-service/metering-job |
| `travel/assistant` | `assistant_metering_degraded` | environment, reason | Sum | ai-service/metering-job |
| `travel/assistant` | `AssistantFirstTokenP50` | (ADOT) | p50 | ai-service/ADOT |
| `travel/assistant` | `AssistantFirstTokenP95` | (ADOT) | p95 | ai-service/ADOT |
| `travel/assistant` | `AssistantFirstTokenP99` | (ADOT) | p99 | ai-service/ADOT |
| `travel/assistant` | `AssistantFaultRate` | (ADOT) | Average | ai-service/ADOT |
| `travel/assistant` | `AssistantRequestRate` | (ADOT) | Sum | ai-service/ADOT |

---

## travel/search — Search Latency & Cache (WO-011, WO-038)

Emitted by search services via ADOT sidecar.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/search` | `SearchResponseP50` | (ADOT) | p50 | search-services/ADOT |
| `travel/search` | `SearchResponseP95` | (ADOT) | p95 | search-services/ADOT |
| `travel/search` | `SearchResponseP99` | (ADOT) | p99 | search-services/ADOT |
| `travel/search` | `SearchCacheHitP95` | (ADOT) | p95 | search-services/ADOT |
| `travel/search` | `SearchRequestRate` | (ADOT) | Sum | search-services/ADOT |
| `travel/search` | `SearchFaultRate` | (ADOT) | Average | search-services/ADOT |
| `travel/search` | `SearchLatencyByCategory` | (ADOT) | p95 | search-services/ADOT |
| `travel/search` | `search_cache_unavailable_total` | (ADOT) | Sum | search-services/ADOT |
| `travel/search` | `SupplierBreakerTransitionsTotal` | (ADOT) | Sum | search-services/ADOT |
| `travel/search` | `search_cache_hits_total` | (ADOT) | Sum | search-services/ADOT |
| `travel/search` | `search_cache_misses_total` | (ADOT) | Sum | search-services/ADOT |
| `travel/search` | `search_cache_stale_serves_total` | (ADOT) | Sum | search-services/ADOT |
| `travel/search` | `illustrative_offers_served_total` | (ADOT) | Sum | search-services/ADOT |

---

## travel/checkout — Checkout & Payment Latency (WO-011)

Emitted by `booking-service` via ADOT sidecar.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/checkout` | `CheckoutAckP50` | (ADOT) | p50 | booking-service/ADOT |
| `travel/checkout` | `CheckoutAckP95` | (ADOT) | p95 | booking-service/ADOT |
| `travel/checkout` | `CheckoutAckP99` | (ADOT) | p99 | booking-service/ADOT |
| `travel/checkout` | `CheckoutFaultRate` | (ADOT) | Average | booking-service/ADOT |
| `travel/checkout` | `PlatformAttributableCheckoutFailureRate` | (ADOT) | Average | booking-service/ADOT |

---

## travel/platform — Platform-Level Security & Auth (WO-011)

Emitted by platform-wide middleware via ADOT.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/platform` | `AuthFailures` | (ADOT) | Sum | auth-service/ADOT |
| `travel/platform` | `AccessDenied` | (ADOT) | Sum | api-gateway/ADOT |
| `travel/platform` | `StripeSignatureFailures` | (ADOT) | Sum | payment-service/ADOT |
| `travel/platform` | `IllustrativeExposureUnflagged` | (ADOT) | Sum | search-services/ADOT |

---

## travel/booking — Booking & Audit Operational Metrics

Emitted by `booking-service` and the audit partition maintenance job.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/booking` | `AuditPartitionMissingNext` | environment | Sum | booking-service/audit-partition |
| `travel/booking` | `PartitionMaintenanceErrors` | environment | Sum | booking-service/audit-partition |
| `travel/booking` | `BookingInsertLatencyP95` | environment | p95 | booking-service/ADOT |

---

## travel/purge — Retention Purge Worker

Emitted by `retention-worker` via ADOT.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/purge` | `purge_category_failures_total` | environment | Sum | retention-worker |
| `travel/purge` | `purge_rows_purged_total` | environment | Sum | retention-worker |
| `travel/purge` | `purge_category_duration_ms` | environment | Average | retention-worker |
| `travel/purge` | `purge_runs_started_total` | environment | Sum | retention-worker |

---

## travel/payment — Payment Reconciliation (WO-050)

Emitted by the daily reconciliation job.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/payment` | `payment_reconciliation_exceptions_total` | environment | Sum | reconciliation-job |

---

## travel/security — Security Events

Emitted by security middleware across services.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/security` | `webhook_signature_failures_total` | environment, provider | Sum | payment-service |
| `travel/security` | `access_control_denials_total` | environment, route | Sum | api-gateway |
| `travel/security` | `illustrative_result_exposures_total` | environment | Sum | search-services |

---

## travel/ci — CI-Published Metrics

Published by the test pipeline step via `aws cloudwatch put-metric-data`.
Absence of this metric after a CI run triggers a no-data alarm.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `travel/ci` | `test_coverage_pct` | environment, suite | Maximum | forge-pipeline/test-step |

---

## AWS/ApplicationELB — Native ALB Metrics

AWS-managed metrics, no custom emission required.

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `AWS/ApplicationELB` | `RequestCount` | LoadBalancer | Sum | AWS-managed |
| `AWS/ApplicationELB` | `HTTPCode_Target_5XX_Count` | LoadBalancer | Sum | AWS-managed |
| `AWS/ApplicationELB` | `HTTPCode_Target_4XX_Count` | LoadBalancer | Sum | AWS-managed |
| `AWS/ApplicationELB` | `TargetResponseTime` | LoadBalancer | p95 | AWS-managed |
| `AWS/ApplicationELB` | `HealthyHostCount` | LoadBalancer, TargetGroup | Minimum | AWS-managed |

---

## AWS/SQS — Native SQS Metrics

| namespace | metric_name | dimensions | stat | owner |
|---|---|---|---|---|
| `AWS/SQS` | `ApproximateNumberOfMessagesVisible` | QueueName | Maximum | AWS-managed |
| `AWS/SQS` | `ApproximateAgeOfOldestMessage` | QueueName | Maximum | AWS-managed |
