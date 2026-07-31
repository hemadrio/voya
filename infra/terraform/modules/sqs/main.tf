/**
 * SQS module — FIFO domain-event queue, DLQ, redrive policy, KMS encryption,
 * per-role IAM policies, and CloudWatch alarms.
 *
 * Architecture:
 *   - One FIFO queue for ordered domain events (booking.confirmed, etc.).
 *     content-based deduplication DISABLED — the application supplies an
 *     explicit MessageDeduplicationId (envelope.eventId) so we keep full
 *     control over the dedup window.
 *   - One FIFO DLQ.  After maxReceiveCount (5) failed deliveries the SQS
 *     redrive policy moves the message here automatically.
 *   - KMS encryption using the shared "sqs" CMK from the kms module.
 *   - Least-privilege IAM:
 *       publisher role  → sqs:SendMessage on the main queue only.
 *       consumer role   → sqs:ReceiveMessage, sqs:DeleteMessage,
 *                          sqs:ChangeMessageVisibility on the main queue.
 *       dlq consumer    → sqs:ReceiveMessage, sqs:DeleteMessage on DLQ.
 *   - CloudWatch alarms wired to the existing SNS topic (var.alarm_sns_arn):
 *       main-queue depth > 100 (autoscaling trigger for the consumer).
 *       DLQ depth >= 1       (on-call alert — any DLQ message is actionable).
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

  alarm_actions = [var.alarm_sns_arn]

  tags = var.common_tags
}
