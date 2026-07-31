# DLQ Redrive Runbook — Notification Service

**SOC 2 Evidence Reference:** This document is referenced in the `${var.environment}-notification-service-queue-depth-high` CloudWatch alarm description.

## Overview

The notification-service DLQ (`${env}-travel-domain-events-dlq.fifo`) receives messages when:
1. The dispatcher encounters a non-retryable failure (Zod validation error, unknown event type, permanent SES rejection).
2. A retryable failure (SES throttling, transient DB/Redis error) exhausts all 5 delivery attempts.

DLQ messages are retained for 14 days. A CloudWatch alarm fires when DLQ depth ≥ 1.

---

## Step 1 — Inspect the message

List DLQ messages without deleting them (visibility timeout method):

```bash
# Get the DLQ URL for the target environment
DLQ_URL=$(aws sqs get-queue-url \
  --queue-name "${ENV}-travel-domain-events-dlq.fifo" \
  --query 'QueueUrl' --output text)

# Peek at messages (visibility timeout = 30s, does NOT delete)
aws sqs receive-message \
  --queue-url "$DLQ_URL" \
  --max-number-of-messages 10 \
  --visibility-timeout 30 \
  --message-attribute-names All
```

Each message body is a JSON `QueueMessageEnvelope`. Extract key fields:

```bash
# Pipe through jq to extract event metadata (no PII logged)
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 1 \
  | jq '.Messages[].Body | fromjson | {eventId, eventType, correlationId, schemaVersion}'
```

---

## Step 2 — Classify the failure cause

Check CloudWatch Logs for the correlation ID from the message:

```bash
aws logs filter-log-events \
  --log-group-name "/ecs/${ENV}/notification-service" \
  --filter-pattern "{ $.correlationId = \"<CORRELATION_ID>\" }" \
  --start-time $(date -d '24 hours ago' +%s000) \
  | jq '.events[].message | fromjson | {event, errName, err}'
```

| `errName` in logs | Cause | Action |
|---|---|---|
| `UnknownEventTypeError` | New event type added without template mapping | Deploy a code fix, then redrive |
| `PayloadValidationError` | Schema drift — publisher sent unexpected payload | Fix publisher or update schema, then redrive |
| `SesPermanentRejectionError` | SES identity not verified / account paused | Check SES console, verify identity, then redrive |
| `SesThrottlingError` (after 5 attempts) | SES burst quota exceeded | Request quota increase, then redrive with lower concurrency |
| `TransientDbError` (after 5 attempts) | RDS Proxy connection exhausted | Scale connection limit, restart Prisma migrations, then redrive |
| Generic `Error` | Unknown — investigate logs | Fix root cause, then redrive |

---

## Step 3 — Fix or discard

### Fix and redrive

If the root cause is fixed (code deployed, SES identity verified, etc.):

```bash
# Redrive with a bounded batch (max 10 at a time to avoid reintroducing burst)
SOURCE_QUEUE_URL=$(aws sqs get-queue-url \
  --queue-name "${ENV}-travel-domain-events.fifo" \
  --query 'QueueUrl' --output text)

aws sqs start-message-move-task \
  --source-arn "$(aws sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text)" \
  --destination-arn "$(aws sqs get-queue-attributes \
    --queue-url "$SOURCE_QUEUE_URL" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text)" \
  --max-number-of-messages-per-second 1
```

Monitor the move task:
```bash
aws sqs list-message-move-tasks \
  --source-arn "$(aws sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --attribute-names QueueArn --output text)"
```

### Discard (purge) unrecoverable messages

Only if messages are confirmed to be permanently invalid (e.g., synthetic test data in production, schema version too old to upgrade):

```bash
# IRREVERSIBLE — confirm with team lead and incident commander first
aws sqs purge-queue --queue-url "$DLQ_URL"
```

Log the purge action in the incident ticket with:
- Environment
- Approximate message count
- Reason for purge
- Who approved
- Timestamp

---

## Step 4 — Verify resolution

1. Confirm DLQ depth returns to 0:
   ```bash
   aws sqs get-queue-attributes \
     --queue-url "$DLQ_URL" \
     --attribute-names ApproximateNumberOfMessages \
     | jq '.Attributes.ApproximateNumberOfMessages'
   ```

2. Confirm the CloudWatch alarm returns to `OK` state (allow up to 2 evaluation periods = 2 minutes).

3. Confirm redriven messages appear in CloudWatch Logs as `notification.sent`:
   ```bash
   aws logs filter-log-events \
     --log-group-name "/ecs/${ENV}/notification-service" \
     --filter-pattern '{ $.event = "notification.sent" }' \
     --start-time $(date -d '10 minutes ago' +%s000)
   ```

---

## Escalation

| Scenario | Escalate to |
|---|---|
| DLQ depth > 100 and growing | On-call platform engineer + service owner |
| SES sending paused | AWS Support + platform lead |
| Purge decision needed | Incident commander + service owner approval |
| PII suspected in DLQ message | Data protection officer immediately |

---

## Prevention

- **Exactly-once guard**: the `notification_processed_events` unique constraint prevents double-sends on redrive.
- **Suppression list**: suppressed recipients are skipped on redrive — no repeat sends to bounced addresses.
- **FIFO ordering**: `MessageGroupId = userId` preserves cancellation-after-confirmation ordering on redrive.
- **Bounded redrive rate**: `max-number-of-messages-per-second 1` prevents re-triggering SES throttling.
