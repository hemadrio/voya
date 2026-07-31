# Runbook: HIGH-purge-run-failure-compliance

**Alarm:** `HIGH-purge-run-failure-compliance`
**Severity:** HIGH
**Namespace / Metric:** `travel/purge` / `purge_run_failures_total`

## Detection signal
CloudWatch alarm fires when `purge_run_failures_total > 0` in a 1-hour window. This means at least one retention category in the daily purge run encountered an error.

## Blast radius
- One or more data categories were NOT purged on schedule.
- GDPR retention timelines may be exceeded for the affected category if the failure persists across multiple runs.
- SOC 2 CC7 (System Operations) automated lifecycle control is degraded.

## Immediate containment
1. Check `/ecs/{env}/retention-worker` logs for `event=purge.category.failure`.
2. Identify the affected category (e.g. `users.identity`, `booking_travelers.identity_documents`).
3. If a DB constraint is failing: check whether the retention period config key is set correctly in the environment.
4. If KMS decrypt is failing: verify the purge worker task role has `kms:Decrypt` on the purge CMK.
5. If the table has unexpected row locks: check for long-running transactions holding locks.
6. Retry the purge worker manually in dry-run mode first, then with `--apply` once the root cause is confirmed.

## Escalation path
1. On-call engineer: triage (0–30 min)
2. DB lead: if lock or constraint issue
3. Compliance Lead: notification required if failure persists >24 hours

## Evidence to attach to the incident record
- Retention worker logs for the failed run (structured JSON with category and error class)
- DB error details (without PII or secret values)
- Purge evidence artefact from the evidence bucket (if the collector ran after the purge failure)
