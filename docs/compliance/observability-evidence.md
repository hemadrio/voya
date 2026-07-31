# SOC 2 Observability Evidence Note

**Control area:** A09 — Monitoring Procedures / Alerting on Access and Authentication Events
**Date committed:** 2026-07-31
**Maintained by:** Platform Engineering

---

## 1. Structured Logging

All services use **Pino** for structured JSON logging.  Every log line contains:
- `level` (numeric: 10 debug, 20 trace, 30 info, 40 warn, 50 error, 60 fatal)
- `event` — stable, uppercase_underscore event code (e.g. `AUTH_FAILED`, `STRIPE_SIGNATURE_INVALID`)
- `correlationId` — trace propagation identifier linking request logs across services
- `service` — emitting service name
- `@timestamp` — ISO 8601 UTC

CloudWatch Logs metric filters in `monitoring-log-filters.tf` target the `event` field directly, so alerting is **decoupled from application code changes**: no application update is needed to start or stop emitting these metrics.

---

## 2. PII Redaction at the Logger Layer

The Pino logger is configured with a `redact` path list applied before any log line is serialised or transmitted.  The following paths are redacted to `[REDACTED]` at the logger, never appearing in CloudWatch Logs:

| Path | Reason |
|---|---|
| `email` | Personal identifier |
| `firstName`, `lastName` | Personal identifier |
| `dateOfBirth` | Sensitive personal data |
| `passportNumber` | Sensitive personal data |
| `phoneNumber` | Contact information |
| `cardNumber`, `cvv`, `cvc` | Payment data (PCI) |
| `passwordHash`, `password` | Credential |
| `rawToken`, `refreshTokenHash` | Authentication secret |
| `authorization` | HTTP header carrying Bearer tokens |

Redaction is applied at the logger configuration level (not per log call), ensuring no developer omission can leak these fields.

---

## 3. A09 Alerting Coverage

Policy A09 requires alerting on authentication and access-control failure events.  The following alarms satisfy this requirement:

| Event | Alarm | Severity | Topic |
|---|---|---|---|
| Authentication failures (`AUTH_FAILED`) | `HIGH-auth-failure-spike` | HIGH | platform-ticket |
| Access-control denials (`ACCESS_DENIED`) | `HIGH-access-denied-spike` | HIGH | platform-ticket |
| Stripe webhook sig failure (`STRIPE_SIGNATURE_INVALID`) | `CRITICAL-stripe-signature-failure` | CRITICAL | platform-page |
| Validation failures (`VALIDATION_FAILED`) | `HIGH-validation-failure-spike` | HIGH | platform-ticket |
| Illustrative result exposure (`ILLUSTRATIVE_EXPOSURE_UNFLAGGED`) | `CRITICAL-illustrative-exposure-unflagged-log` | CRITICAL | platform-page |

All alarms are defined as Terraform resources in `monitoring-alarms.tf` and `compliance-alarms.tf`, ensuring drift is visible in pull requests.  Every alarm carries:
- A non-empty `alarm_description` containing a runbook link
- At least one `alarm_actions` entry pointing to an SNS topic
- Explicit `treat_missing_data`

---

## 4. Log Retention

| Store | Retention | Basis |
|---|---|---|
| Application logs (CloudWatch Logs) | **30 days** | CloudWatch log group `retention_in_days = 30` |
| Audit records (append-only PostgreSQL partition) | **1 year (365 days)** | Separate immutable audit store; records are never deleted; only actor linkage may be pseudonymised per GDPR |
| SOC 2 evidence artefacts (S3 Object Lock) | **365 days minimum** | compliance mode Object Lock; `evidence_retention_days >= 365` enforced by Terraform validation |

The audit record store is **separate** from the application log store: a CloudWatch log group purge at 30 days does not affect audit records.  This separation is a deliberate architectural constraint (AC for WO-103, WO-105).

---

## 5. Evidence Collector Heartbeat

The SOC 2 compliance evidence collector (WO-105) emits a `evidence_collector_heartbeat` metric on every successful run.  The `HIGH-evidence-collection-gap` alarm fires if no heartbeat is received within 25 hours, ensuring a missed run is detected before it creates a gap in the SOC 2 observation window.

---

## 6. Availability SLO

Monthly availability objective: **99.5%** (error budget: 0.5% ≈ 216 minutes/month).

Calculation:
```
availability (%) = (RequestCount - HTTPCode_Target_5XX_Count) / RequestCount × 100
```

Sourced from native ALB metrics.  Error-budget burn alarms:
- **Fast-burn** (`CRITICAL`): >7.2% error rate in a 1-hour window (14.4× burn rate, 2% of budget)
- **Slow-burn** (`HIGH`): >3.0% error rate in a 6-hour window (6× burn rate, 5% of budget)

---

*This document is updated as part of the infrastructure change process.  Any change to logging, redaction paths, or alarm thresholds requires an update to this file and a pull-request review.*
