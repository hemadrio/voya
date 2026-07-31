/**
 * SQS module — domain-event queues, DLQs, KMS encryption, IAM policies, and alarms.
 *
 * Queue inventory (WO-083):
 *   booking-events.fifo  — FIFO, explicit dedup ID, maxReceiveCount=5 → booking-events-dlq.fifo
 *   payment-events.fifo  — FIFO, explicit dedup ID, maxReceiveCount=5 → payment-events-dlq.fifo
 *   notifications         — Standard queue, maxReceiveCount=5 → notifications-dlq
 *   travel-domain-events.fifo — Legacy generic FIFO queue (retained for compatibility)
 *
 * All queues are encrypted with the SQS KMS CMK.
 * FIFO queues use deduplication_scope=messageGroup so the 5-minute dedup window
 * is scoped per booking/payment ID message group rather than the entire queue —
 * preventing silent dedup of legitimate retries with different message-group IDs.
 *
 * Publishers must supply an explicit MessageDeduplicationId derived from the
 * domain entity ID (booking ID, payment ID) — content-based deduplication
 * is DISABLED. Consumers must handle at-least-once delivery.
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ── FIFO DLQ ────────────────────────────────────────────────────────────────

resource "aws_sqs_queue" "dlq" {
  name                        = "${var.environment}-travel-domain-events-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  kms_master_key_id           = var.kms_key_arn
  message_retention_seconds   = 1209600 # 14 days — maximum

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-domain-events-dlq"
    Purpose = "Dead-letter queue for failed domain event processing"
  })
}

# ── FIFO main queue ─────────────────────────────────────────────────────────

resource "aws_sqs_queue" "domain_events" {
  name                        = "${var.environment}-travel-domain-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  kms_master_key_id           = var.kms_key_arn
  visibility_timeout_seconds  = 300 # Must be >= handler timeout (5 min)
  message_retention_seconds   = 345600 # 4 days
  receive_wait_time_seconds   = 20 # Long polling default

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-domain-events"
    Purpose = "FIFO domain event queue for async booking/payment/notification flow"
  })
}

# ── Redrive allow policy (DLQ must grant the main queue permission) ──────────

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.url

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.domain_events.arn]
  })
}

# ── IAM — publisher policy (sqs:SendMessage on main queue only) ─────────────

data "aws_iam_policy_document" "publisher" {
  statement {
    sid    = "AllowSendToMainQueue"
    effect = "Allow"

    actions = ["sqs:SendMessage"]

    resources = [aws_sqs_queue.domain_events.arn]

    # Restrict to encrypted messages only — plaintext sends are rejected.
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["true"]
    }
  }
}

resource "aws_iam_policy" "publisher" {
  name        = "${var.environment}-travel-queue-publisher"
  description = "Allows booking-service and payment-service to publish domain events to the FIFO queue"
  policy      = data.aws_iam_policy_document.publisher.json
  tags        = var.common_tags
}

# ── IAM — consumer policy (receive/delete/changeVisibility on main queue) ────

data "aws_iam_policy_document" "consumer" {
  statement {
    sid    = "AllowConsumeFromMainQueue"
    effect = "Allow"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]

    resources = [aws_sqs_queue.domain_events.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["true"]
    }
  }

  # KMS decrypt permission so the consumer can read encrypted message bodies.
  statement {
    sid    = "AllowKmsDecrypt"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]

    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "consumer" {
  name        = "${var.environment}-travel-queue-consumer"
  description = "Allows notification-service to receive and process domain events from the FIFO queue"
  policy      = data.aws_iam_policy_document.consumer.json
  tags        = var.common_tags
}

# ── IAM — DLQ consumer policy ────────────────────────────────────────────────

data "aws_iam_policy_document" "dlq_consumer" {
  statement {
    sid    = "AllowConsumeFromDlq"
    effect = "Allow"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]

    resources = [aws_sqs_queue.dlq.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["true"]
    }
  }

  statement {
    sid    = "AllowKmsDecryptDlq"
    effect = "Allow"

    actions = ["kms:Decrypt"]

    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_policy" "dlq_consumer" {
  name        = "${var.environment}-travel-queue-dlq-consumer"
  description = "Allows the DLQ processor to drain and inspect dead-lettered domain events"
  policy      = data.aws_iam_policy_document.dlq_consumer.json
  tags        = var.common_tags
}

# ── CloudWatch alarm — main queue depth > 100 ───────────────────────────────
# Used as the ApproximateNumberOfMessagesVisible trigger for consumer autoscaling.

resource "aws_cloudwatch_metric_alarm" "queue_depth" {
  alarm_name          = "${var.environment}-travel-domain-events-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 100
  alarm_description   = "Domain event queue depth exceeds 100 — consumer may be falling behind. Review autoscaling policy."
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.domain_events.name
  }

  alarm_actions = [var.alarm_sns_arn]
  ok_actions    = [var.alarm_sns_arn]

  tags = var.common_tags
}

# ── CloudWatch alarm — DLQ depth >= 1 ────────────────────────────────────────
# Any message in the DLQ is actionable and should page on-call immediately.

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${var.environment}-travel-domain-events-dlq-depth"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "Dead-letter queue has >= 1 message — a domain event failed all 5 delivery attempts. Investigate immediately."
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  # Notify ticket topic always; also page on-call when oncall_sns_arn is provided.
  alarm_actions = compact([var.alarm_sns_arn, var.oncall_sns_arn])

  tags = var.common_tags
}

# =============================================================================
# Per-domain queues (WO-083)
# =============================================================================

# ── booking-events.fifo ────────────────────────────────────────────────────────

resource "aws_sqs_queue" "booking_events_dlq" {
  name                        = "${var.environment}-booking-events-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  kms_master_key_id           = var.kms_key_arn
  message_retention_seconds   = 1209600 # 14 days

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-booking-events-dlq"
    Purpose = "Dead-letter queue for failed booking event processing"
  })
}

resource "aws_sqs_queue" "booking_events" {
  name                        = "${var.environment}-booking-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  # deduplication_scope=messageGroup scopes the 5-minute dedup window per booking ID
  # message group, preventing silent dedup of legitimate retries across groups.
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"
  kms_master_key_id           = var.kms_key_arn
  visibility_timeout_seconds  = 300
  message_retention_seconds   = 345600 # 4 days
  receive_wait_time_seconds   = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.booking_events_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-booking-events"
    Purpose = "FIFO queue for booking domain events (booking.created, booking.confirmed, etc.)"
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "booking_events_dlq" {
  queue_url = aws_sqs_queue.booking_events_dlq.url

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.booking_events.arn]
  })
}

# ── payment-events.fifo ────────────────────────────────────────────────────────

resource "aws_sqs_queue" "payment_events_dlq" {
  name                        = "${var.environment}-payment-events-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  kms_master_key_id           = var.kms_key_arn
  message_retention_seconds   = 1209600

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-payment-events-dlq"
    Purpose = "Dead-letter queue for failed payment event processing"
  })
}

resource "aws_sqs_queue" "payment_events" {
  name                        = "${var.environment}-payment-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"
  kms_master_key_id           = var.kms_key_arn
  visibility_timeout_seconds  = 300
  message_retention_seconds   = 345600
  receive_wait_time_seconds   = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.payment_events_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-payment-events"
    Purpose = "FIFO queue for payment domain events (payment.initiated, payment.confirmed, etc.)"
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "payment_events_dlq" {
  queue_url = aws_sqs_queue.payment_events_dlq.url

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.payment_events.arn]
  })
}

# ── notifications (standard queue) ────────────────────────────────────────────

resource "aws_sqs_queue" "notifications_dlq" {
  name                      = "${var.environment}-notifications-dlq"
  kms_master_key_id         = var.kms_key_arn
  message_retention_seconds = 1209600

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-notifications-dlq"
    Purpose = "Dead-letter queue for failed notification deliveries"
  })
}

resource "aws_sqs_queue" "notifications" {
  name                       = "${var.environment}-notifications"
  kms_master_key_id          = var.kms_key_arn
  visibility_timeout_seconds = 60
  message_retention_seconds  = 86400 # 1 day (notifications are time-sensitive)
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notifications_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-notifications"
    Purpose = "Standard queue for email/push notification delivery"
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "notifications_dlq" {
  queue_url = aws_sqs_queue.notifications_dlq.url

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.notifications.arn]
  })
}

# ── CloudWatch alarms for new queues ──────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "booking_events_dlq_depth" {
  alarm_name          = "${var.environment}-booking-events-dlq-depth"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "Booking events DLQ has >= 1 message — a booking event failed all delivery attempts."
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.booking_events_dlq.name
  }

  alarm_actions = compact([var.alarm_sns_arn, var.oncall_sns_arn])
  tags          = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "payment_events_dlq_depth" {
  alarm_name          = "${var.environment}-payment-events-dlq-depth"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "Payment events DLQ has >= 1 message — a payment event failed all delivery attempts. Investigate immediately."
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.payment_events_dlq.name
  }

  alarm_actions = compact([var.alarm_sns_arn, var.oncall_sns_arn])
  tags          = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "notifications_dlq_depth" {
  alarm_name          = "${var.environment}-notifications-dlq-depth"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "Notifications DLQ has >= 1 message — notification delivery failed all attempts."
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.notifications_dlq.name
  }

  alarm_actions = compact([var.alarm_sns_arn, var.oncall_sns_arn])
  tags          = var.common_tags
}
