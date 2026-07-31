# Runbook: Stripe Webhook Signature Failure (Zero-Tolerance)

**Alarm:** `CRITICAL-stripe-signature-failure`
**Severity:** CRITICAL
**SNS Topic:** platform-page

> See also: [`webhook-signature-failure.md`](webhook-signature-failure.md) for the HIGH-severity spike alarm (≥5 failures in 5 min).

## Signal Meaning

Any single Stripe webhook HMAC signature verification failure triggers this CRITICAL alarm. Even one failure may indicate:
- **Replay attack**: an attacker replaying a captured webhook with an expired timestamp.
- **Misconfigured webhook secret**: `STRIPE_WEBHOOK_SECRET` in Secrets Manager does not match the Stripe Dashboard endpoint signing secret.
- **Known test source**: a Stripe CLI `stripe trigger` or sandbox test delivery — this still fires but the runbook defines a triage path.

**Zero-tolerance rationale**: a missed webhook means a payment confirmation is not processed, leaving a booking in PENDING state indefinitely. The alarm must fire on every failure.

## Triage: Is This a Known Test Source?

1. Check if the failure correlates with a developer running `stripe trigger` in development:
   - Examine the log's `ipAddress` or `userAgent` field — Stripe CLI sends from known IP ranges.
   - Check Slack `#deployments` for developer activity at the time.
2. If confirmed test source: acknowledge the alarm (no ticket required), add a note to the incident log, and confirm the developer is using the development endpoint, not production.
3. If NOT a test source: proceed with all steps below.

## Diagnostic Steps

1. **Open the Checkout and Payment Dashboard** → `{environment}-checkout-payment-journey`. Check whether bookings are accumulating in PENDING state.

2. **Run the Logs Insights query** against `/ecs/{environment}/payment-service`:
   ```
   fields @timestamp, correlationId, stripeEventId, stripeEventType, ipAddress, event, errorDetail, @message
   | filter event = "STRIPE_SIGNATURE_INVALID"
   | sort @timestamp desc
   | limit 20
   ```
   Note `stripeEventId` and `stripeEventType`. Cross-check against the Stripe Dashboard webhook event log.

3. **Verify the webhook secret** matches:
   ```
   aws secretsmanager get-secret-value \
     --secret-id {environment}/payment-service/stripe-webhook-secret \
     --query SecretString --output text
   ```
   Compare against the Stripe Dashboard → Developers → Webhooks → signing secret. If they differ, rotate and update (see Stripe rotation SOP in `docs/ops/stripe-secret-rotation.md`).

## Expected Blast Radius

- Webhooks with invalid signatures are rejected; the corresponding booking remains in PENDING.
- Stripe retries webhook delivery for 3 days — once the secret is corrected, pending events will be retried.

## Escalation

- Confirmed webhook secret mismatch: fix within 30 min (Stripe retries expire after 3 days).
- Evidence of replay attack: escalate to Security Incident Response and rotate the webhook secret immediately.
