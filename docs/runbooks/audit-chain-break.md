# Runbook: CRITICAL-audit-chain-break

**Alarm:** `CRITICAL-audit-chain-break`
**Severity:** CRITICAL
**Namespace / Metric:** `travel/audit` / `audit_chain_breaks_total`

## Detection signal
CloudWatch alarm fires when `audit_chain_breaks_total ≥ 1` within a 5-minute period. Emitted by the evidence collector's `AuditChainVerifier` adapter when a row's `prev_hash` pointer is missing where one is required.

## Blast radius
- Possible unauthorised mutation of the immutable `booking_audit_log` table.
- SOC 2 CC6 integrity control is breached for the affected row sequence.
- Chain break must be treated as a potential security incident until proven otherwise.

## Immediate containment
1. Record the `firstBreakAt` row ID from the evidence artefact in the evidence bucket.
2. Pull the affected rows: `SELECT id, prev_hash, action, actor_id, occurred_at FROM booking_audit_log WHERE id >= '<firstBreakAt>' ORDER BY id LIMIT 50;`
3. Verify whether the `prev_hash` column is `NULL` on an interior row (should only be `NULL` on the very first row).
4. Check PostgreSQL `pg_stat_activity` and `pg_stat_user_tables.n_tup_upd` for unexpected UPDATE counts on `booking_audit_log`.
5. If UPDATE count is non-zero for an append-only table: treat as a security incident. Notify Security Lead immediately.
6. Preserve a read-only snapshot of the affected rows as evidence before any remediation attempt.

## Escalation path
1. On-call engineer: immediate triage
2. Security Lead: within 15 minutes if UPDATE activity detected
3. Compliance Lead: notification required regardless of outcome
4. Legal / DPO: if chain break affects GDPR-relevant audit rows

## Evidence to attach to the incident record
- Evidence artefact from `{env}/CC6/{date}/{control_id}-{runId}.json` (S3 Object Lock protects it)
- PostgreSQL `pg_stat_user_tables` snapshot
- `booking_audit_log` rows around `firstBreakAt`
- CloudTrail events for direct DB access in the window
