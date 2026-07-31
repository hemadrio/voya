# Runbook: HIGH-webhook-signature-failure-spike

**Alarm:** `HIGH-webhook-signature-failure-spike`
**Severity:** HIGH
**Namespace / Metric:** `travel/security` / `webhook_signature_failures_total`

## Detection signal
CloudWatch alarm fires when `webhook_signature_failures_total ≥ 5` in a 5-minute window. Individual failures can occur during key rotation; a spike indicates something more serious.

## Blast radius
- Payment confirmations are not being processed (bookings remain in PENDING state).
- Possible replay attack, misconfigured Stripe webhook secret, or active MITM attempt.

## Immediate containment
1. Check Stripe Dashboard for the webhook endpoint status and recent event delivery attempts.
2. Compare the `Stripe-Signature` header timestamps — are all failures from the same 5-minute window? (Could be a delayed delivery outside the 300-second tolerance window.)
3. Verify the `STRIPE_WEBHOOK_SECRET` in Secrets Manager matches the Stripe Dashboard endpoint signing secret.
4. If the secret has drifted: rotate the Stripe webhook secret and update Secrets Manager, then restart the payment-service tasks.
5. If timing-based: check for clock skew on ECS tasks (NTP sync issue).
6. If an IP or user-agent pattern is visible in the failed requests: add a WAF rule to block the source.

## Escalation path
1. On-call engineer: immediate triage (0–15 min)
2. Stripe support: if Stripe's own delivery shows failures
3. Security Lead: if attack pattern is suspected

## Evidence to attach to the incident record
- CloudWatch Logs for `{ $.event = "webhook.signature.invalid" }` from the alarm window
- Stripe Dashboard: webhook delivery logs for the endpoint
- `Stripe-Signature` header timestamp distribution from the failed requests
