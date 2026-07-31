# Runbook: Checkout Fault Rate / Checkout Latency

**Alarms:** `CRITICAL-checkout-fault-rate`, `CRITICAL-checkout-latency-p95`, `HIGH-alb-5xx-fault-rate`
**Severity:** CRITICAL
**SNS Topic:** platform-page

## Signal Meaning

| Alarm | Threshold | Meaning |
|---|---|---|
| `checkout-fault-rate` | 5xx > 1.0% over 5 min | Checkout journey platform fault rate breached |
| `checkout-latency-p95` | p95 > 5000 ms, 3 of 5 datapoints | Checkout acknowledgement SLO breach |
| `alb-5xx-fault-rate` | edge-level 5xx > 1.0% | Cross-journey view; may indicate gateway-level issue |

Distinguish **platform faults (500)** from **supplier failures (502/504)**. A Stripe payment service 502 is supplier scope; a booking-service unhandled exception is platform scope.

## Diagnostic Steps

1. **Open the Checkout and Payment Dashboard** → `{environment}-checkout-payment-journey`. Check whether ALB TargetResponseTime p95 matches the checkout EMF alarm. If ALB is healthy but EMF is alarming, the issue is service-internal (not network).

2. **Run the Logs Insights query** against `/ecs/{environment}/booking-service`:
   ```
   fields @timestamp, correlationId, service, statusCode, errorCode, @message
   | filter statusCode >= 500
   | stats count(*) as errorCount by statusCode, errorCode, service
   | sort errorCount desc
   | limit 20
   ```
   Correlate `correlationId` with the payment-service logs if Stripe errors are suspected.

3. **Check the Stripe webhook signature alarm** (`CRITICAL-stripe-signature-failure`). If Stripe is rejecting our webhook or we are rejecting Stripe's, payment confirmation may be blocked even if the booking-service appears healthy.

## Expected Blast Radius

- Checkout fault rate breach: new booking confirmations are failing. Existing confirmed bookings are unaffected.
- Checkout latency breach: customers see slow confirmation pages; may cause duplicate submission attempts.

## Escalation

- 10 min without root cause identified: escalate to Payments team lead.
- Confirmed Stripe outage: check `https://status.stripe.com` and open P1 incident with Stripe support.
