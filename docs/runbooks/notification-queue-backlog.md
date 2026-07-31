# Runbook: Notification Queue Backlog

**Alarms:** `HIGH-notification-queue-depth`, `HIGH-notification-queue-oldest-message`
**Severity:** HIGH
**SNS Topic:** platform-ticket

## Signal Meaning

| Alarm | Threshold | Meaning |
|---|---|---|
| `notification-queue-depth` | ApproximateNumberOfMessagesVisible > 100 | Consumer is falling behind; queue is building |
| `notification-queue-oldest-message` | ApproximateAgeOfOldestMessage > 300 s | Messages older than 5 min; 99% delivery within 5-min SLO is at risk |

The queue-depth alarm fires when the notification-service consumer cannot drain messages fast enough. The oldest-message alarm is the SLO signal: if any message is older than 5 minutes, the platform has already missed the 5-minute delivery window for at least one notification.

## Diagnostic Steps

1. **Open the Platform Health Dashboard** → `{environment}-platform-health`. Confirm queue depth and age metrics are both elevated, or only one (isolated vs sustained backlog).

2. **Run the Logs Insights query** against `/ecs/{environment}/notification-service`:
   ```
   fields @timestamp, correlationId, recipientId, channel, event, errorCode, @message
   | filter event = "NOTIFICATION_FAILED" or event = "NOTIFICATION_SENT" or level >= 50
   | stats count(*) as count by event, channel, errorCode
   | sort count desc
   | limit 20
   ```
   Look for: SES throttling, SMTP failures, or consumer crash loops.

3. **Check ECS service health** for notification-service: `aws ecs describe-services --cluster {cluster} --services notification-service`. If desired_count > running_count, the service is failing to start — check for recent deployment, OOM kill, or configuration error.

## Expected Blast Radius

- Booking confirmation emails delayed beyond 5 minutes.
- Password reset and 2FA notification emails may be delayed; users may retry and generate duplicate messages.

## Escalation

- 30 min without queue draining: escalate to Notification Service team.
- SES throttling confirmed: request SES sending limit increase from AWS Support.
