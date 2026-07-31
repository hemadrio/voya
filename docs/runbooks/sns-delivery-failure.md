# Runbook: SNS Page Topic Delivery Failure

**Alarm:** `HIGH-sns-page-delivery-failure`
**Severity:** HIGH
**SNS Topic:** platform-ticket (to ensure alerting-path failure still creates a ticket)

## Signal Meaning

The `NumberOfNotificationsFailed` metric for the `platform-page` SNS topic has exceeded zero. This means at least one critical alarm notification was not delivered to the on-call endpoint (PagerDuty/Opsgenie). The alerting path itself may be broken.

**This is a meta-alarm**: it monitors the monitoring infrastructure. When this fires, previously delivered alarms may have been silently dropped.

## Diagnostic Steps

1. **Check SNS topic delivery logs** in CloudWatch:
   ```
   fields @timestamp, @message
   | filter @logStream like /sns\/delivery/
   | sort @timestamp desc
   | limit 20
   ```
   Look for `HTTP 4xx` (subscription endpoint rejected), `HTTP 5xx` (PagerDuty/Opsgenie degraded), or `connect timeout`.

2. **Verify the subscription endpoint** is healthy: check PagerDuty or Opsgenie status pages. If the on-call tool is degraded, confirm incidents are being routed via backup channels (email, phone escalation).

3. **Check the SNS subscription** is confirmed:
   ```
   aws sns list-subscriptions-by-topic --topic-arn <platform-page-arn>
   ```
   An unconfirmed subscription (status: `PendingConfirmation`) will drop all messages. Re-trigger confirmation if needed.

## Expected Blast Radius

- Critical alarms (CRITICAL-*) may not have paged on-call during the delivery failure window.
- Review CloudWatch Alarms console directly to identify any alarms in ALARM state that were not paged.

## Escalation

- Delivery failure persisting >5 min: manually notify on-call via backup channel (phone, email).
- Confirm all critical alarms are in OK state before closing the incident.
