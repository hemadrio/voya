# Runbook: CRITICAL-audit-write-failure

**Alarm:** `CRITICAL-audit-write-failure`
**Severity:** CRITICAL
**Namespace / Metric:** `travel/audit` / `audit_write_failures_total`

## Detection signal
CloudWatch alarm fires when `audit_write_failures_total ≥ 1` in any 1-minute period. Every failure is a compliance control breach — the audit trail is incomplete for that interval.

## Blast radius
- SOC 2 CC6 (Logical Access) audit coverage has a gap for the interval between the failure and remediation.
- Affected operations (e.g. booking state transitions, auth events) have no immutable record.
- The gap must be disclosed to the Compliance Lead and documented in the incident record.

## Immediate containment
1. Check `/ecs/{env}/booking-service` logs for `event=audit.write.error` within the alarm window.
2. Identify the failing DB write — look for connection timeouts, constraint violations, or partition errors.
3. If the DB is unreachable: escalate to on-call DB engineer. Do NOT route around the audit write.
4. If a partition is missing: run the partition maintenance task manually (see `docs/runbooks/connection-governance.md`).
5. If the write is failing due to a bug: roll back the offending deployment.

## Escalation path
1. On-call engineer: initial triage (0–15 min)
2. DB/Infra lead: if DB-related (15–30 min)
3. Compliance Lead: notification required within 1 hour regardless of cause

## Evidence to attach to the incident record
- CloudWatch Logs Insights query: `{ $.event = "audit.write.error" }` over the alarm window
- ECS task ID and container exit code
- RDS `pg_stat_activity` snapshot at time of failure
- Booking IDs that lacked an audit row (recoverable from application logs if present)
