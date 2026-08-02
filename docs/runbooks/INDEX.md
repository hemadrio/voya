# Runbook Index — Alarm-to-Runbook Map

Every CloudWatch alarm defined in `infra/terraform/` maps to exactly one runbook below.
The CI check (`scripts/check-runbook-coverage.ts`) fails the build when any alarm is unmapped
or a runbook references an alarm that does not exist in the Terraform SLO module.

**Runbook format:** Each entry lists the exact `alarm_name` from Terraform and the runbook file
that covers it. One alarm maps to exactly one primary runbook; cross-references are noted.

---

## CRITICAL Alarms

| Alarm name | Runbook | Notes |
|------------|---------|-------|
| `CRITICAL-assistant-cost-per-booking-ceiling-breach` | [saga-partial-failure.md](saga-partial-failure.md) | Assistant governor failure path |
| `CRITICAL-audit-chain-break` | [audit-chain-break.md](audit-chain-break.md) | Hash-chain integrity |
| `CRITICAL-audit-write-failure` | [audit-write-failure.md](audit-write-failure.md) | Audit log write path |
| `CRITICAL-availability-slo-fast-burn` | [availability-error-budget-burn.md](availability-error-budget-burn.md) | SLO burn rate |
| `CRITICAL-checkout-fault-rate` | [saga-partial-failure.md](saga-partial-failure.md) | Checkout 5xx; see also checkout-fault-rate.md |
| `CRITICAL-checkout-latency-p95` | [checkout-fault-rate.md](checkout-fault-rate.md) | Checkout p95 SLO |
| `CRITICAL-dsr-gdpr-window-breach` | [dsr-gdpr-window-breach.md](dsr-gdpr-window-breach.md) | GDPR DSR response window |
| `CRITICAL-funnel-emitter-heartbeat-missing` | [telemetry-verification.md](telemetry-verification.md) | Funnel emitter stall; see also WO-106 |
| `CRITICAL-illustrative-exposure-unflagged-log` | [illustrative-result-exposure.md](illustrative-result-exposure.md) | Non-bookable offer logged unflagged |
| `CRITICAL-illustrative-result-exposure` | [illustrative-result-exposure.md](illustrative-result-exposure.md) | Illustrative offer served to traveler |
| `CRITICAL-payment-reconciliation-exception` | [payment-reconciliation-exception.md](payment-reconciliation-exception.md) | Daily reconciliation failure |
| `CRITICAL-platform-degradation-composite` | [availability-error-budget-burn.md](availability-error-budget-burn.md) | Composite multi-service degradation |
| `CRITICAL-reconciliation-exceptions` | [reconciliation-job-triage.md](reconciliation-job-triage.md) | Zero-exception gate breach |
| `CRITICAL-reconciliation-missed-run` | [reconciliation-job-triage.md](reconciliation-job-triage.md) | Daily reconciliation job not started |
| `CRITICAL-search-cache-unavailable` | [cache-degradation.md](cache-degradation.md) | Redis cache unavailable |
| `CRITICAL-search-fault-rate` | [supplier-outage.md](supplier-outage.md) | All suppliers failing; empty-state path |
| `CRITICAL-search-illustrative-offers-served` | [illustrative-result-exposure.md](illustrative-result-exposure.md) | Non-bookable illustrative in results |
| `CRITICAL-search-latency-p95-by-category-hard` | [supplier-outage.md](supplier-outage.md) | Per-category p95 hard breach |
| `CRITICAL-search-latency-p95-hard` | [search-latency-breach.md](search-latency-breach.md) | Overall p95 hard SLO breach |
| `CRITICAL-secret-startup-validation-failure` | [secret-rotation.md](secret-rotation.md) | Missing/placeholder secret at startup |
| `CRITICAL-stripe-signature-failure` | [stripe-signature-failure.md](stripe-signature-failure.md) | Zero-tolerance webhook HMAC failure |

---

## HIGH Alarms

| Alarm name | Runbook | Notes |
|------------|---------|-------|
| `HIGH-access-control-denial-spike` | [access-control-denial-spike.md](access-control-denial-spike.md) | RBAC denial spike |
| `HIGH-access-denied-spike` | [access-control-denial-spike.md](access-control-denial-spike.md) | Auth access denied spike; related to HIGH-access-control-denial-spike |
| `HIGH-adot-exporter-failure` | [adot-collector-failure.md](adot-collector-failure.md) | ADOT collector failure |
| `HIGH-alb-5xx-fault-rate` | [checkout-fault-rate.md](checkout-fault-rate.md) | ALB edge 5xx |
| `HIGH-assistant-cap-breach-rate` | [saga-partial-failure.md](saga-partial-failure.md) | Assistant call cap hit repeatedly |
| `HIGH-assistant-cost-per-booking-warning` | [saga-partial-failure.md](saga-partial-failure.md) | Assistant cost warning threshold |
| `HIGH-assistant-first-token-p95` | [saga-partial-failure.md](saga-partial-failure.md) | AI first-token p95 latency |
| `HIGH-assistant-metering-degraded` | [saga-partial-failure.md](saga-partial-failure.md) | Assistant metering subsystem degraded |
| `HIGH-assistant-metering-heartbeat-absent` | [saga-partial-failure.md](saga-partial-failure.md) | Assistant metering heartbeat missing |
| `HIGH-auth-failure-spike` | [auth-failure-spike.md](auth-failure-spike.md) | Authentication failure spike |
| `HIGH-availability-slo-slow-burn` | [availability-error-budget-burn.md](availability-error-budget-burn.md) | SLO slow burn rate |
| `HIGH-evidence-collection-gap` | [evidence-collection-gap.md](evidence-collection-gap.md) | SOC 2 evidence gap |
| `HIGH-funnel-emission-failed` | [telemetry-verification.md](telemetry-verification.md) | Funnel store write failures |
| `HIGH-funnel-events-dropped` | [telemetry-verification.md](telemetry-verification.md) | Funnel buffer overflow / dropped events |
| `HIGH-latency-degradation-composite` | [availability-error-budget-burn.md](availability-error-budget-burn.md) | Composite latency degradation |
| `HIGH-domain-events-dlq-depth` | [dlq-redrive.md](dlq-redrive.md) | Domain-events DLQ has ≥1 message |
| `HIGH-domain-events-queue-depth` | [notification-queue-backlog.md](notification-queue-backlog.md) | Domain-events FIFO queue depth > 100; consumer autoscaling trigger |
| `HIGH-notification-queue-depth` | [notification-queue-backlog.md](notification-queue-backlog.md) | SQS queue depth high |
| `HIGH-notification-queue-oldest-message` | [notification-queue-backlog.md](notification-queue-backlog.md) | SQS oldest message age |
| `HIGH-purge-run-failure-compliance` | [purge-run-failure.md](purge-run-failure.md) | Retention purge job failure |
| `HIGH-search-cache-latency-p95-warning` | [search-latency-breach.md](search-latency-breach.md) | Cache read latency warning |
| `HIGH-search-cache-stale-serve-rate` | [cache-degradation.md](cache-degradation.md) | Stale cache responses |
| `HIGH-search-latency-p95-by-category-warning` | [supplier-outage.md](supplier-outage.md) | Per-category p95 warning |
| `HIGH-search-latency-p95-warning` | [search-latency-breach.md](search-latency-breach.md) | Overall p95 warning |
| `HIGH-search-supplier-breaker-open` | [supplier-outage.md](supplier-outage.md) | Circuit breaker OPEN |
| `HIGH-sli-feed-no-data-assistant` | [telemetry-verification.md](telemetry-verification.md) | Assistant SLI feed absent |
| `HIGH-sli-feed-no-data-availability` | [telemetry-verification.md](telemetry-verification.md) | Availability SLI feed absent |
| `HIGH-sli-feed-no-data-checkout` | [telemetry-verification.md](telemetry-verification.md) | Checkout SLI feed absent |
| `HIGH-sli-feed-no-data-search` | [telemetry-verification.md](telemetry-verification.md) | Search SLI feed absent |
| `HIGH-sns-page-delivery-failure` | [sns-delivery-failure.md](sns-delivery-failure.md) | SNS page delivery failure |
| `HIGH-validation-failure-spike` | [validation-failure-spike.md](validation-failure-spike.md) | Request validation failure spike |
| `HIGH-webhook-signature-failure-spike` | [webhook-signature-failure.md](webhook-signature-failure.md) | Webhook HMAC spike (≥5 failures / 5 min) |

---

## INFO Alarms

| Alarm name | Runbook | Notes |
|------------|---------|-------|
| `INFO-alb-request-count-step-scaling` | [alb-request-count-breach.md](alb-request-count-breach.md) | ALB request step-scaling trigger |

---

## Purge / Partition / Expiry Alarms

| Alarm name | Runbook | Notes |
|------------|---------|-------|
| `audit-log-partition-maintenance-error` | [cache-degradation.md](cache-degradation.md) | Audit log partition maintenance failure |
| `audit-log-partition-missing-next-month` | [cache-degradation.md](cache-degradation.md) | Next-month partition not pre-created |
| `booking-insert-latency-p95` | [supplier-outage.md](supplier-outage.md) | Booking write latency — may co-fire with supplier outage |
| `expiry-sweep-high-failure-count` | [stripe-webhook-delayed.md](stripe-webhook-delayed.md) | PENDING booking expiry sweep failures |
| `expiry-sweep-not-running` | [stripe-webhook-delayed.md](stripe-webhook-delayed.md) | Expiry sweep not starting on schedule |
| `expiry-sweep-sustained-backlog` | [stripe-webhook-delayed.md](stripe-webhook-delayed.md) | PENDING backlog growing |
| `purge-category-failure` | [purge-run-failure.md](purge-run-failure.md) | Retention purge category failure |
| `purge-overlong-run` | [purge-run-failure.md](purge-run-failure.md) | Purge run exceeded time budget |
| `purge-run-not-started` | [purge-run-failure.md](purge-run-failure.md) | Purge job did not start |
| `purge-zero-progress` | [purge-run-failure.md](purge-run-failure.md) | Purge running but deleting nothing |
| `search-response-p95` | [supplier-outage.md](supplier-outage.md) | Raw search response time p95 |
| `staging-fis-experiment-stop-condition` | [resilience-scenarios.md](resilience-scenarios.md) | FIS experiment stop condition fired |

---

## Variable-name Alarms (resolved at deploy time)

The following Terraform alarm names use `${var.environment}` interpolation and resolve
to environment-specific names at apply time. The CI coverage check skips names containing
`${` — they are covered by the runbooks listed here.

| Terraform expression | Resolved example | Runbook |
|---------------------|-----------------|---------|
| `${var.environment}-document-generation-failure` | `staging-document-generation-failure` | [evidence-collection-gap.md](evidence-collection-gap.md) |
| `${var.environment}-notification-service-queue-depth-high` | `staging-notification-service-queue-depth-high` | [notification-queue-backlog.md](notification-queue-backlog.md) |

---

## How to add a new alarm

1. Add the alarm to a Terraform file in `infra/terraform/`.
2. Author or update a runbook in `docs/runbooks/` referencing the alarm name in the
   `**Alarms:**` front matter field.
3. Add a row to the appropriate section above.
4. Run `npx tsx scripts/check-runbook-coverage.ts` locally to verify coverage passes.
5. The CI pipeline (`runbook-coverage` stage) will fail the build if coverage is incomplete.
