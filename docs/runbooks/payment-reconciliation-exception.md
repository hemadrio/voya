# Runbook: CRITICAL-payment-reconciliation-exception

**Alarm:** `CRITICAL-payment-reconciliation-exception`
**Severity:** CRITICAL
**Namespace / Metric:** `travel/payment` / `payment_reconciliation_exceptions_total`

## Detection signal
CloudWatch alarm fires when `payment_reconciliation_exceptions_total > 0` in the daily check. Objective O3 requires zero unreconciled payments at daily close.

## Blast radius
- One or more confirmed bookings do not have a matching settled payment event.
- Revenue integrity is at risk — may indicate a lost webhook, a Stripe charge that failed after booking confirmation, or a double-booking idempotency failure.
- Financial reporting for the day is incorrect until resolved.

## Immediate containment
1. Pull exception booking IDs from the payment reconciliation evidence artefact.
2. For each booking: `SELECT status, offer_snapshot->>'price', contact_email FROM bookings WHERE id = '<id>';`
3. Check Stripe Dashboard: search by `metadata.booking_id` to find the corresponding charge/payment intent.
4. If Stripe shows "succeeded" but no webhook was received: manually trigger reconciliation or process the missed event.
5. If Stripe shows "failed" after booking was confirmed: initiate refund and cancellation saga. Notify Finance immediately.
6. If no matching Stripe record exists: escalate to Finance — possible fraud or system error.

## Escalation path
1. On-call engineer: triage and Stripe lookup (0–15 min)
2. Finance: notification within 30 min regardless of cause
3. Head of Engineering: if the exception count is >5 or involves a fraud signal

## Evidence to attach to the incident record
- Payment reconciliation evidence artefact from S3
- Stripe Dashboard payment intent IDs for each exception booking
- Booking service state transition audit log for the affected bookings (non-PII)
- Resolution steps and timestamps for Finance sign-off
