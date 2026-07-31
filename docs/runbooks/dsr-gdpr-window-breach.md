# Runbook: CRITICAL-dsr-gdpr-window-breach

**Alarm:** `CRITICAL-dsr-gdpr-window-breach`
**Severity:** CRITICAL
**Namespace / Metric:** `travel/compliance` / `dsr_gdpr_window_breaches_total`

## Detection signal
CloudWatch alarm fires when `dsr_gdpr_window_breaches_total > 0` in a daily check. Emitted by the evidence collector when any outstanding data subject request is ≥30 days old.

## Blast radius
- One or more data subjects have not received their rights response within the GDPR-mandated 30-day window.
- Regulatory obligation breached — potential supervisory authority notification required (72-hour notification window for breaches with supervisory implications).
- Legal and DPO must be notified immediately.

## Immediate containment
1. Pull the list of breaching request IDs from the DSR fulfilment timings evidence artefact in S3.
2. Query `data_subject_requests` for each ID: `SELECT id, type, status, requested_at FROM data_subject_requests WHERE id IN (...);`
3. For export requests: check whether the ExportWorker job is stuck (status = "processing" for >24 hours). Manually re-queue if needed.
4. For erasure requests: check the erasure orchestration log for failures.
5. Notify the affected subject(s) with an interim update (GDPR requires communication of delays).
6. Escalate to DPO within 1 hour.

## Escalation path
1. On-call engineer: immediate triage and request status check (0–15 min)
2. DPO / Legal: within 1 hour regardless of cause
3. Supervisory authority notification: DPO assesses obligation within 24 hours

## Evidence to attach to the incident record
- DSR fulfilment timings evidence artefact (`{env}/CC6/{date}/cc6-dsr-fulfilment-{runId}.json`)
- Breaching request IDs (non-PII — internal UUIDs only)
- User-service logs for the affected requests
- Resolution steps taken and timestamps
