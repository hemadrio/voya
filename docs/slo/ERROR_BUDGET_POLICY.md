# Error Budget Policy

**Status:** Active  
**Owner:** SRE / Platform Engineering (primary); Product (feature-freeze decisions)  
**Decision Owner:** Engineering Lead (VP/Director of Engineering) — named for escalation clarity  
**Last Updated:** 2026-08-01  
**Review Cadence:** Monthly during SLO review; at budget exhaustion (ad-hoc)

> Operational decisions during an incident are pre-agreed below so they are not negotiated under pressure.

---

## 1. Error Budget Summary

| SLO | Target | Monthly Budget (30-day) | Budget (minutes) |
|-----|--------|------------------------|------------------|
| Platform Availability | ≥ 99.5 % | 0.5 % | ~216 min (≈ 3 h 36 min) |
| Search Latency p95 | ≤ 3 000 ms | Latency budget (no fixed minutes) | — |
| Search Cache-Hit p95 | ≤ 180 ms | Latency budget | — |
| Checkout Latency p95 | ≤ 5 000 ms | Latency budget | — |
| Assistant First-Token p95 | ≤ 2 000 ms | Latency budget | — |
| Server-Fault Rate | < 1.0 % | Error rate budget | — |
| Notification Delivery | ≥ 99 % within 5 min | 1.0 % of notifications | — |

**Availability budget arithmetic (30-day month):**  
`43 200 min × (1 − 0.995) = 43 200 × 0.005 = 216 minutes = 3 hours 36 minutes`

---

## 2. Consumption Thresholds and Required Responses

### 2.1 — 0–50 % Consumed (Green)

**State:** Budget healthy; normal development and release cadence.

**Required actions:**  
- None mandatory; routine post-incident reviews within 5 business days.
- Monitor burn-rate alarms weekly during SRE review.

**Deployment policy:** Normal; all feature work proceeds.

---

### 2.2 — 50 % Consumed (Yellow)

**State:** Half the monthly budget has been used. At the current pace, the budget will be exhausted by the end of the month if the burn rate is sustained.

**Required actions:**  
1. Engineering Lead reviews current burn-rate dashboard within 24 hours.
2. On-call engineer files an incident ticket with root-cause analysis for the largest contributing incident(s).
3. Reliability improvements are prioritised in the next sprint.

**Deployment policy:** Reduced-risk deploys only; no large refactors or high-risk schema migrations without explicit Engineering Lead approval.

---

### 2.3 — 75 % Consumed (Amber)

**State:** Three-quarters of the monthly budget consumed. The remaining budget covers approximately 54 minutes of unavailability.

**Required actions:**  
1. Engineering Lead escalates to VP Engineering within 4 hours.
2. All non-critical feature work is paused; reliability work only for the remainder of the period.
3. Incident post-mortem with action items due within 48 hours.
4. Daily burn-rate review by Engineering Lead until budget is below 50 %.

**Deployment policy:**  
- **Feature freeze begins.** Only security patches and reliability fixes may be deployed.
- All deploys require approval from Engineering Lead (separation of duty: cannot be the same person who wrote the change).
- Deployments use canary with automatic rollback enabled (see rollback trigger below).

---

### 2.4 — 100 % Consumed (Red — Budget Exhausted)

**State:** The monthly error budget is exhausted. Any further unavailability violates the committed SLO.

**Required actions:**  
1. Engineering Lead immediately notifies VP Engineering and product stakeholders.
2. **Feature freeze is in effect for the remainder of the calendar month.** No feature changes may be deployed regardless of risk classification.
3. **Automatic rollback is triggered** for any deployment that degrades any SLI within 15 minutes of deployment.
4. Incident post-mortem with signed-off action plan due within 72 hours.
5. Error budget is formally reviewed at next monthly SLO review with root-cause and corrective actions.

**Deployment policy:**  
- Hard freeze: no deployments except emergency security patches approved by VP Engineering.
- Rollback decision is pre-delegated to the on-call engineer — no manager approval required for rollback.
- The platform deploy pipeline enforces the freeze via the `BUDGET_EXHAUSTED` pipeline flag (set by the SRE team in `infra/terraform/envs/<env>/terraform.tfvars`).

---

## 3. Feature Freeze and Rollback Triggers

### Feature Freeze

A feature freeze activates at **75 % budget consumption** (see §2.3) and escalates to a hard freeze at **100 %** (see §2.4).

The freeze covers:
- All new feature flags and A/B test activations
- Database migrations that add or modify indexes
- Service configuration changes
- Third-party integration updates

The freeze does **not** cover:
- Security patches (CVE severity High or Critical)
- Compliance-mandated data corrections
- Rollbacks

### Rollback Trigger

The rollback trigger is pre-delegated to the on-call engineer without manager approval when **any** of the following conditions exist:
- A fast-burn alarm (`CRITICAL-availability-slo-fast-burn`) fires within 15 minutes of a deployment
- The checkout fault rate exceeds 1.0 % within 15 minutes of a deployment
- The error budget is exhausted (100 %) and any SLI degrades post-deployment

**Rollback procedure:** docs/runbooks/deploy-and-rollback.md  
**Rollback SLO:** Complete within 5 minutes of decision (ECS rolling update with minimum healthy 100 %).

---

## 4. Burn-Rate Alert Response Playbook

### Fast-Burn Alarm (`CRITICAL-availability-slo-fast-burn`)

Fires when: 1-hour error rate > 7.2 % (14.4× burn rate at 99.5 % SLO).

- On-call engineer has **30 minutes** to diagnose and decide to fix or roll back.
- If not mitigated within 30 minutes, escalate to Engineering Lead.
- Runbook: docs/runbooks/availability-error-budget-burn.md

### Slow-Burn Alarm (`HIGH-availability-slo-slow-burn`)

Fires when: 6-hour error rate > 3.0 % (6× burn rate).

- Creates an incident ticket with 24-hour SLA for root-cause analysis.
- No immediate page unless the fast-burn alarm also fires.
- Runbook: docs/runbooks/availability-error-budget-burn.md

---

## 5. Budget Reset and Month Boundary

- The error budget resets at 00:00 UTC on the first day of each calendar month.
- An in-flight incident at the month boundary does **not** reset; the incident record is preserved and the new month starts with a fresh budget.
- Cumulative consumption is tracked in the `travel/platform` CloudWatch namespace metric `slo_budget_consumed_minutes`.

---

## 6. Related Documents

- [SLO Specification](./SLO_SPECIFICATION.md)
- [ADR-0010: Error Budget and Burn-Rate Alerting Policy](../adr/0010-error-budget-policy.md)
- [Availability Error Budget Burn Runbook](../runbooks/availability-error-budget-burn.md)
- [Deploy and Rollback Runbook](../runbooks/deploy-and-rollback.md)
