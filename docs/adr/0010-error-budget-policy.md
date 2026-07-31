# ADR-0010: Error Budget and Burn-Rate Alerting Policy

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Platform Engineering, SRE, Product
**Owner:** SRE / Platform Engineering

---

## Context

The platform has published SLOs (Service Level Objectives) for the three primary user journeys:
- Search (cache miss): p95 latency ≤ 3,000 ms; availability ≥ 99.9 %
- Checkout acknowledgement: p95 latency ≤ 5,000 ms; availability ≥ 99.95 %
- Assistant first token: p95 latency ≤ 2,000 ms; availability ≥ 99.9 %

Without an error budget policy, SLO breaches are discovered retrospectively (monthly review) rather than proactively. A burn-rate alerting policy converts a monthly SLO target into a set of CloudWatch Alarms that fire when the current consumption rate would exhaust the error budget before the measurement window closes.

---

## Decision

Apply Google SRE-style burn-rate alerting using a two-window, two-threshold approach for each SLO:

| Alert | Burn rate | Short window | Long window | Severity |
|---|---|---|---|---|
| Critical (page) | 14× | 1 hour | 5 minutes | PagerDuty critical |
| Warning (ticket) | 6× | 6 hours | 30 minutes | PagerDuty warning |

Burn rate is defined as: `(error_rate_in_window / (1 - SLO_target))`. A 14× burn rate on a 99.9 % SLO means the error budget would be exhausted in 30 days / 14 ≈ 2.1 days if the current rate continued.

CloudWatch Alarms use the `M of N` alarm evaluation model: the short window (`M = 1 of 5 minutes`) confirms the signal is not a transient spike; the long window (`N = 5 of 6 hours`) confirms the burn is sustained.

The policy applies to all three SLO dimensions:
1. **Availability SLO**: alarm on `5xx_rate > (1 - SLO) × burn_rate` over the respective windows using CloudWatch Metrics `5XXError` from the ALB target group.
2. **Latency SLO**: alarm on the `p95_latency` percentile metric exceeding the SLO threshold over the respective windows.

When a critical alarm fires, the on-call engineer has a budget of 30 minutes to diagnose and either fix or roll back. When a warning alarm fires, a ticket is created in the engineering backlog with a 24-hour SLA for root cause.

---

## Rationale

The two-window, two-threshold approach from Google SRE's "Alerting on SLOs" chapter minimises false-positive alerts (which erode on-call trust) while preserving the 2-day early-warning window for high burn rates. A single-window approach produces more false positives from transient spikes; the short confirmation window catches genuine incidents within minutes. The burn-rate framing converts the abstract "99.9 % availability" SLO into a concrete, actionable signal: "the budget for the next 30 days will be exhausted in 2 days."

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Monthly SLO review only (no proactive alerting) | Incidents are discovered retrospectively; a high burn rate in week 1 may not be caught until the SLO is already breached |
| Single-threshold, single-window alerting | Higher false-positive rate; transient spikes trigger pages even when the budget is healthy |
| Static threshold alerting (e.g., 5xx > 1 %) | Does not account for error budget accumulation; a 1 % error rate is acceptable on a 99 % SLO but critical on a 99.9 % SLO; burn-rate framing makes the severity relative to the SLO |
| External SLO monitoring (Datadog, Nobl9) | Adds a third-party GDPR processor; CloudWatch Alarms integrate natively with SNS → PagerDuty without data leaving the AWS account |

---

## Consequences

**Positive:**
- On-call engineers receive actionable alerts within minutes of a high-burn-rate incident rather than discovering the breach in a monthly review.
- The two-window model minimises false positives and preserves on-call trust.
- Burn-rate framing makes it explicit how many days of budget remain, which informs the rollback vs. fix decision.
- CloudWatch Alarms integrate with SNS → PagerDuty via the existing alarm-to-topic wiring without additional data egress.

**Negative / Trade-offs:**
- The burn-rate calculation requires CloudWatch Metrics for both 5xx rate and latency percentile; high-resolution metrics (1-minute resolution) are required for the 5-minute short window, which costs more than default 5-minute resolution.
- The 14× and 6× burn-rate thresholds are derived from the Google SRE guideline; they should be tuned after 30 days of production data if the false-positive rate is higher than expected.

**Neutral / Notes:**
- The error budget for 99.9 % availability over 30 days is 43.2 minutes. A 14× burn rate consumes this in ~3 hours; the critical alert fires within 1 hour of the incident starting, giving ~2 hours to mitigate.
- The CloudWatch Alarm ARNs and SNS topic ARNs are managed in Terraform (`infra/terraform/modules/monitoring/`).
- See `docs/runbooks/` for the on-call response procedure for each alarm.

---

## Status History

| Date | Status | Note |
|---|---|---|
| 2026-07-31 | Accepted | Ratified from architecture artifact; Google SRE methodology applied |
