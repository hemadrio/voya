# Runbook: Daily Reconciliation Job — Triage Guide (WO-050)

**Alarm:** `CRITICAL-reconciliation-exceptions` or `CRITICAL-reconciliation-missed-run`
**Severity:** CRITICAL
**Namespace / Metric:** `travel/payment` / `ReconciliationExceptions`, `ReconciliationTransactionsCompared`
**Escalation owner:** Platform Engineering on-call → Finance (any exception kind) → Head of Engineering (exception count > 5)

---

## Overview

The daily reconciliation job (`node dist/jobs/reconciliation.js`) runs at 02:00 UTC via EventBridge.
It pages Stripe settled balance transactions for the previous day, compares them against the local
payments ledger and booking states, and persists exceptions into `reconciliation_exceptions`.

A **clean run** has `exception_count = 0`. The Phase 2 exit gate requires 14 consecutive clean runs
(`clean_run = true` in `reconciliation_runs`).

Report artifacts are written to S3 at `s3://<bucket>/reconciliation/<YYYY-MM-DD>/report.json` and
`summary.txt` — both are server-side encrypted with the dedicated KMS key. Reports contain no card
data and no personal identifiers beyond internal booking IDs.

---

## Diagnostic queries

### Find today's run
```sql
SELECT id, period_date, status, transactions_compared, exception_count, clean_run,
       correct_terminal_pct, started_at, finished_at
FROM reconciliation_runs
WHERE period_date = CURRENT_DATE - 1
ORDER BY started_at DESC
LIMIT 1;
```

### List unresolved exceptions for a given period
```sql
SELECT kind, booking_id, payment_intent_id, provider_reference,
       expected_amount_minor, actual_amount_minor, detail, detected_at
FROM reconciliation_exceptions
WHERE period_date = '<YYYY-MM-DD>'
  AND resolved_at IS NULL
ORDER BY kind, detected_at;
```

### Consecutive clean-day count (14-day gate)
```sql
WITH recent AS (
  SELECT period_date, clean_run,
         ROW_NUMBER() OVER (ORDER BY period_date DESC) AS rn
  FROM reconciliation_runs
  WHERE status = 'COMPLETED'
  ORDER BY period_date DESC
  LIMIT 14
)
SELECT COUNT(*) AS consecutive_clean_days
FROM recent
WHERE clean_run = true
  AND rn <= (SELECT MIN(rn) FROM recent WHERE clean_run = false);
-- Returns the count of most-recent consecutive clean days.
-- If all 14 rows are clean, returns 14.
```

---

## Exception kind: `SETTLED_WITHOUT_CONFIRMATION`

**Meaning:** Stripe shows a settled charge for a booking that is not in `CONFIRMED` state.

**Root causes:**
- Webhook not delivered or processing failed (check `processed_events` for the Stripe event ID).
- Booking expired before the webhook arrived (see `CONFIRMATION_AFTER_TERMINAL` below).
- Race condition between expiry sweep and webhook delivery — normal for charges that settled within minutes of expiry.

**Diagnostic steps:**
1. Look up the Stripe PaymentIntent in the Dashboard using `payment_intent_id`.
2. Query the booking: `SELECT id, status, updated_at FROM bookings WHERE id = '<booking_id>';`
3. Check `processed_events`: `SELECT * FROM processed_events WHERE event_id = '<stripe_event_id>';`
4. If no `processed_events` row exists, the webhook was lost — manually trigger reconciliation or replay the Stripe event.
5. If the booking is EXPIRED with a settled charge, initiate a refund and set the exception as resolved.

**Remediation:**
- Lost webhook → Stripe Dashboard → "Resend webhook" → confirm the event is processed.
- Refund the charge if the booking cannot be confirmed.
- Mark resolved: `UPDATE reconciliation_exceptions SET resolved_at = now() WHERE id = '<exception_id>';`

---

## Exception kind: `CONFIRMED_WITHOUT_SETTLEMENT`

**Meaning:** A `CONFIRMED` booking has no matching settled Stripe charge in the provider data for this period.

**Root causes:**
- Stripe settlement pending (T+1 or T+2 settlement window) — expect resolution in the next 1–2 days.
- Charge reversed or disputed before settlement — rare.
- Data pipeline bug: the booking was confirmed by a non-payment path (test or manual override).

**Diagnostic steps:**
1. Query the payment: `SELECT * FROM payments WHERE booking_id = '<booking_id>' AND type = 'CHARGE';`
2. Check Stripe Dashboard for the `provider_reference` PaymentIntent.
3. If Stripe shows "succeeded" but not yet settled, wait for the settlement window.
4. If Stripe shows a dispute or reversal, escalate to Finance immediately.

**Remediation:**
- Settlement pending → no action required; re-run tomorrow will clear if settled.
- Dispute/reversal → Finance notification + investigation.

---

## Exception kind: `REFUND_WITHOUT_CANCELLATION`

**Meaning:** Stripe processed a refund for a booking that is not `CANCELLED`.

**Root causes:**
- Booking cancellation event not processed by the booking service.
- Manual Stripe refund issued by ops without going through the platform cancellation flow.
- Partial refund for an upgrade or amendment (not yet modelled as cancellation).

**Diagnostic steps:**
1. Look up the refund in Stripe Dashboard using `provider_reference` (re_...).
2. Query booking: `SELECT id, status, updated_at FROM bookings WHERE id = '<booking_id>';`
3. Check booking audit log: `SELECT * FROM booking_audit_log WHERE booking_id = '<booking_id>' ORDER BY occurred_at;`

**Remediation:**
- If refund is legitimate and booking should be cancelled: process cancellation via the booking service.
- If manual refund was issued by ops: add a note, cancel the booking, mark exception resolved.

---

## Exception kind: `AMOUNT_MISMATCH`

**Meaning:** The settled Stripe amount (in minor units) differs from the ledger amount.

**Root causes:**
- Price change between PaymentIntent creation and settlement (unusual but possible with partial captures).
- Currency conversion applied by Stripe (when presentment ≠ settlement currency).
- Data entry error in the ledger (extremely rare).

**Diagnostic steps:**
1. Compare `expected_amount_minor` (ledger) vs `actual_amount_minor` (Stripe) in the exception row.
2. Look up the PaymentIntent in Stripe Dashboard — check "Amount" vs "Net".
3. Verify the currency in both the ledger and the Stripe transaction.
4. If the difference is exactly a Stripe fee, check Stripe Dashboard for fee deductions.

**Remediation:**
- Currency conversion difference → not a reconciliation failure; add to exception detail and resolve.
- Actual amount shortfall → Finance notification + investigation.

---

## Exception kind: `CURRENCY_MISMATCH`

**Meaning:** The settlement currency from Stripe does not match the currency stored in the payments ledger.

**Root causes:**
- Stripe account configured with automatic currency conversion.
- Multi-currency misconfiguration in the PaymentIntent creation.

**Diagnostic steps:**
1. Compare `expected_amount_minor` currency (ledger row `currency`) vs `actual_amount_minor` currency from the exception `detail`.
2. Check Stripe Dashboard for the payment's presentment vs settlement currency.

**Remediation:**
- Resolve by matching the ledger row currency to the Stripe settlement currency.
- Update the platform's currency configuration if Stripe conversion is unintentional.

---

## Exception kind: `CONFIRMATION_AFTER_TERMINAL`

**Meaning:** Stripe settled a charge for a booking that was already `EXPIRED` or `CANCELLED`.

**Root causes:**
- Stripe webhook arrived after the expiry sweep marked the booking as EXPIRED.
- Late webhook delivery (Stripe retries webhooks for up to 72 hours).

**Diagnostic steps:**
1. Check the `processed_events` table for the Stripe event ID to confirm the webhook was processed.
2. Look at the booking audit log for the timeline of status transitions.
3. This exception is also raised by the WO-047 webhook processor — if already logged there, the reconciliation row is a duplicate signal.

**Remediation:**
- Refund the charge: the booking was expired so the traveler was not served.
- Mark exception resolved after refund is confirmed in Stripe.

---

## Exception kind: `ORPHAN_LEDGER_ROW`

**Meaning:** The payments ledger has a CHARGE row for which there is no matching Stripe transaction AND no corresponding booking.

**Root causes:**
- Booking was deleted or purged from the system while its payment record was retained (retention policy mismatch).
- Manual test data that was not cleaned up.
- Database integrity bug (foreign key was SET NULL on deletion but the payment row survived).

**Diagnostic steps:**
1. Query: `SELECT * FROM payments WHERE id = '<ledger_payment_id>';`
2. Check if the booking exists: `SELECT id, status FROM bookings WHERE id = '<booking_id>';` — if NULL FK, check if it was purged.
3. Look in Stripe Dashboard for the `provider_reference` to confirm if a real charge exists.

**Remediation:**
- If Stripe confirms a real charge with no live booking: investigate fraud and escalate to Finance.
- If this is a purged booking with a legitimate charge: ensure the refund was issued before purge; if not, issue the refund.
- If test data: clean up manually and mark resolved.

---

## Alarm: `CRITICAL-reconciliation-missed-run`

**Meaning:** No completed reconciliation run was detected in the last 26 hours.

**Root causes:**
- EventBridge Scheduler disabled or misconfigured.
- ECS task crashing at startup (check task logs in CloudWatch).
- Stripe API rate limiting or outage causing the job to exit non-zero.
- Database connection failure (check `DATABASE_URL` secret in Secrets Manager).
- Pagination cursor stuck in a loop (extremely rare with Stripe's cursor model).

**Diagnostic steps:**
1. Check CloudWatch Logs: `/ecs/${environment}/reconciliation-job` for the most recent task run.
2. Check ECS Task history in the console for the `${environment}-reconciliation-job` family.
3. Verify EventBridge Scheduler: `${environment}-reconciliation-job` — is it `ENABLED`?
4. Check `reconciliation_runs` for any `RUNNING` row older than 26 hours:
   ```sql
   SELECT * FROM reconciliation_runs WHERE status = 'RUNNING' AND started_at < now() - interval '26 hours';
   ```
5. If a stuck RUNNING row exists, the job crashed mid-pagination. Re-run manually with the same `period_date` — it will resume from the persisted cursor.

**Remediation:**
- Restart by triggering EventBridge manually via the AWS Console or CLI:
  ```bash
  aws scheduler create-schedule --name ${environment}-reconciliation-job-manual-trigger ...
  # Or trigger the ECS task directly:
  aws ecs run-task --cluster ${environment} --task-definition ${environment}-reconciliation-job ...
  ```
- If the issue is a Stripe outage, wait for the outage to resolve, then re-run manually.

---

## Re-running the job for a specific date

The job is idempotent for the same date. To re-run:

```bash
# ECS RunTask override (preferred in production):
aws ecs run-task \
  --cluster ${ENVIRONMENT} \
  --task-definition ${ENVIRONMENT}-reconciliation-job \
  --overrides '{"containerOverrides":[{"name":"reconciliation-job","command":["node","dist/jobs/reconciliation.js","--date=2026-08-01"]}]}'

# Local (development only):
node dist/jobs/reconciliation.js --date=2026-08-01
```

A re-run for the same date:
- Resumes from the persisted Stripe cursor (if any).
- Skips exceptions that already exist (unique constraint `uq_reconciliation_exception_kind_ref_period`).
- Updates the `reconciliation_runs` row's totals and status.

---

## Marking exceptions resolved

After triage and remediation:

```sql
UPDATE reconciliation_exceptions
SET resolved_at = now()
WHERE id = '<exception_id>'
   -- Or bulk-resolve all exceptions for a period after a known data fix:
   -- WHERE period_date = '2026-08-01' AND kind = 'SETTLED_WITHOUT_CONFIRMATION';
```

---

## Escalation path

| Time | Action |
|------|--------|
| T+0  | On-call engineer: pull report from S3, run diagnostic queries |
| T+15 | Finance notification (regardless of cause) |
| T+60 | If exception count > 5 or fraud signal: Head of Engineering |
| T+2h | If unresolved: incident declared, Stripe account team notified |
