/**
 * sqs.tf — Domain-events FIFO queue, DLQ, KMS CMK, per-task-role IAM
 * policies, and CloudWatch alarms for queue depth and DLQ depth.
 *
 * WO-051: @travel/queue port with RabbitMQ and SQS adapters.
 *
 * Resources created:
 *   aws_kms_key + aws_kms_alias            — dedicated CMK for queue encryption
 *   aws_sqs_queue (FIFO)                   — domain events queue
 *   aws_sqs_queue (FIFO DLQ)               — dead-letter queue (FIFO queues require FIFO DLQ)
 *   aws_sqs_queue_redrive_policy           — maxReceiveCount=5
 *   aws_iam_policy (publisher)             — sqs:SendMessage on domain events queue
 *   aws_iam_policy (consumer)              — sqs:ReceiveMessage, sqs:DeleteMessage,
 *                                            sqs:ChangeMessageVisibility on domain events queue
 *   aws_cloudwatch_metric_alarm (2)        — main-queue depth > 100, DLQ depth >= 1
 *
 * IAM policy attachment is the responsibility of the ECS task-role module;
 * the ARNs are exported so the environment root module can attach them.
 *
 * Content-based deduplication is disabled — producers supply explicit
 * MessageDeduplicationId (the domain event UUID) so every publish is
 * idempotent within the 5-minute SQS dedup window without relying on SHA-256
 * of the body.
 */

# ---------------------------------------------------------------------------
# Variables — new variables introduced by sqs.tf
#
# Note: booking_service_task_role_arn, environment, aws_account_id, and
# common_tags are declared in kms.tf and shared across the module.
# ---------------------------------------------------------------------------

variable "payment_service_task_role_arn" {
  type        = string
  description = "IAM role ARN for the payment-service ECS task. Granted sqs:SendMessage on the domain-events queue."
  default     = ""
}

variable "notification_service_task_role_arn" {
  type        = string
  description = "IAM role ARN for the notification-service ECS task. Granted sqs:ReceiveMessage, sqs:DeleteMessage, sqs:ChangeMessageVisibility on the domain-events queue."
  default     = ""
}

# ---------------------------------------------------------------------------
# KMS CMK — dedicated key for domain-events queue encryption
#
# Separate from the RDS/ElastiCache CMKs so the blast radius of a key
# compromise is limited to the queue tier.  Annual auto-rotation enabled.
# The account root retains administrative break-glass access; the booking
# and payment services can Generate/Decrypt (needed to send/receive); the
# notification service can Decrypt only.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "sqs_kms_policy" {
  # Break-glass: account root administration
  statement {
    sid    = "AllowAccountRootAdministration"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  # SQS service — required so SQS can use the CMK on behalf of publishers/consumers
  statement {
    sid    = "AllowSqsServiceEncryption"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["sqs.amazonaws.com"]
    }
    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt",
    ]
    resources = ["*"]
  }

  # Publisher task roles — can generate data keys (for sending) and decrypt (for receive back-compat)
  dynamic "statement" {
    for_each = compact([
      var.booking_service_task_role_arn,
      var.payment_service_task_role_arn,
    ])
    content {
      sid    = "AllowPublisherTaskRole-${index(compact([var.booking_service_task_role_arn, var.payment_service_task_role_arn]), statement.value)}"
      effect = "Allow"
      principals {
        type        = "AWS"
        identifiers = [statement.value]
      }
      actions = [
        "kms:GenerateDataKey",
        "kms:Decrypt",
      ]
      resources = ["*"]
    }
  }

  # Consumer task role — decrypt only
  dynamic "statement" {
    for_each = compact([var.notification_service_task_role_arn])
    content {
      sid    = "AllowConsumerTaskRoleDecrypt"
      effect = "Allow"
      principals {
        type        = "AWS"
        identifiers = [statement.value]
      }
      actions = [
        "kms:GenerateDataKey",
        "kms:Decrypt",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_kms_key" "domain_events_sqs" {
  description             = "${var.environment} domain-events SQS FIFO queue CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.sqs_kms_policy.json

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-domain-events-sqs-cmk"
    Purpose = "sqs-encryption"
  })
}

resource "aws_kms_alias" "domain_events_sqs" {
  name          = "alias/${var.environment}-domain-events-sqs"
  target_key_id = aws_kms_key.domain_events_sqs.key_id
}

# ---------------------------------------------------------------------------
# DLQ — must be FIFO because FIFO queues can only target FIFO DLQs
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "domain_events_dlq" {
  name                        = "${var.environment}-travel-domain-events-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false

  # Longer retention on the DLQ so ops have time to inspect and redrive
  message_retention_seconds = 1209600 # 14 days

  kms_master_key_id = aws_kms_key.domain_events_sqs.arn

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-domain-events-dlq"
    Purpose = "domain-events-dlq"
  })
}

# ---------------------------------------------------------------------------
# Main FIFO queue — domain events
#
# content_based_deduplication = false: producers supply explicit
# MessageDeduplicationId (the domain event UUID) for deterministic idempotency.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "domain_events" {
  name                        = "${var.environment}-travel-domain-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = false

  # Visibility timeout: long enough for a slow consumer DB transaction plus
  # one ChangeMessageVisibility extension cycle.
  visibility_timeout_seconds = 300 # 5 minutes

  # Standard retention; the DLQ holds messages for 14 days after redrive.
  message_retention_seconds = 345600 # 4 days

  # Long polling default; consumers override per-call with WaitTimeSeconds=20.
  receive_wait_time_seconds = 20

  kms_master_key_id = aws_kms_key.domain_events_sqs.arn

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-domain-events"
    Purpose = "domain-events-fifo"
  })
}

# ---------------------------------------------------------------------------
# Redrive policy resource (explicit — separate from the queue inline above so
# Terraform tracks it independently and plan output shows it clearly)
# ---------------------------------------------------------------------------

resource "aws_sqs_queue_redrive_policy" "domain_events" {
  queue_url = aws_sqs_queue.domain_events.url

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.domain_events_dlq.arn
    maxReceiveCount     = 5
  })
}

# ---------------------------------------------------------------------------
# IAM — publisher policy (booking-service, payment-service)
#
# Grants only sqs:SendMessage to minimise the blast radius if a task
# credential is compromised.  GetQueueUrl is included so the SDK can
# resolve the URL by name.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "sqs_publisher" {
  statement {
    sid    = "AllowDomainEventPublish"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:GetQueueUrl",
    ]
    resources = [aws_sqs_queue.domain_events.arn]
  }
}

resource "aws_iam_policy" "sqs_publisher" {
  name        = "${var.environment}-domain-events-sqs-publisher"
  description = "Grants sqs:SendMessage on the ${var.environment} domain-events FIFO queue. Attach to booking-service and payment-service task roles."
  policy      = data.aws_iam_policy_document.sqs_publisher.json

  tags = var.common_tags
}

# Attach publisher policy to booking-service task role (if ARN provided)
resource "aws_iam_role_policy_attachment" "booking_sqs_publisher" {
  count      = var.booking_service_task_role_arn != "" ? 1 : 0
  role       = element(split("/", var.booking_service_task_role_arn), length(split("/", var.booking_service_task_role_arn)) - 1)
  policy_arn = aws_iam_policy.sqs_publisher.arn
}

# Attach publisher policy to payment-service task role (if ARN provided)
resource "aws_iam_role_policy_attachment" "payment_sqs_publisher" {
  count      = var.payment_service_task_role_arn != "" ? 1 : 0
  role       = element(split("/", var.payment_service_task_role_arn), length(split("/", var.payment_service_task_role_arn)) - 1)
  policy_arn = aws_iam_policy.sqs_publisher.arn
}

# ---------------------------------------------------------------------------
# IAM — consumer policy (notification-service)
#
# Grants only the three operations required to poll, extend, and delete
# messages.  sqs:SendMessage is intentionally excluded so the consumer
# cannot re-publish to the main queue (it can only delete acknowledged
# messages or let them expire into the DLQ via redrive).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "sqs_consumer" {
  statement {
    sid    = "AllowDomainEventConsume"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueUrl",
    ]
    resources = [aws_sqs_queue.domain_events.arn]
  }
}

resource "aws_iam_policy" "sqs_consumer" {
  name        = "${var.environment}-domain-events-sqs-consumer"
  description = "Grants sqs:ReceiveMessage, sqs:DeleteMessage, sqs:ChangeMessageVisibility on the ${var.environment} domain-events FIFO queue. Attach to notification-service task role."
  policy      = data.aws_iam_policy_document.sqs_consumer.json

  tags = var.common_tags
}

# Attach consumer policy to notification-service task role (if ARN provided)
resource "aws_iam_role_policy_attachment" "notification_sqs_consumer" {
  count      = var.notification_service_task_role_arn != "" ? 1 : 0
  role       = element(split("/", var.notification_service_task_role_arn), length(split("/", var.notification_service_task_role_arn)) - 1)
  policy_arn = aws_iam_policy.sqs_consumer.arn
}

# ---------------------------------------------------------------------------
# CloudWatch alarms
#
# Alarm 1 — main queue depth > 100 visible messages
#   Used as the consumer autoscaling trigger: notification-service scales out
#   on ApproximateNumberOfMessagesVisible > 100.  Routes to the ticket topic
#   so on-call is notified but not paged immediately.
#
# Alarm 2 — DLQ depth >= 1
#   Any message landing in the DLQ means a processing failure exhausted all
#   5 retries (or was a malformed envelope). Zero-tolerance: immediate
#   investigation required.  Routes to the ticket topic.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "domain_events_queue_depth" {
  alarm_name          = "HIGH-domain-events-queue-depth"
  alarm_description   = "Domain-events FIFO queue ApproximateNumberOfMessagesVisible exceeded 100. The notification-service consumer may be falling behind. Check consumer task health and scaling policy. This alarm also serves as the autoscaling trigger for the notification-service. Runbook: ${local.runbook_base_url}/notification-queue-backlog.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = local.threshold_queue_depth
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = aws_sqs_queue.domain_events.name
  }
  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions
}

resource "aws_cloudwatch_metric_alarm" "domain_events_dlq_depth" {
  alarm_name          = "HIGH-domain-events-dlq-depth"
  alarm_description   = "Domain-events DLQ ApproximateNumberOfMessagesVisible is >= 1. A message exhausted all 5 delivery attempts or was an unrecoverable malformed envelope. Investigate dead-letter messages before they expire (14-day retention). Runbook: ${local.runbook_base_url}/dlq-redrive.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = aws_sqs_queue.domain_events_dlq.name
  }
  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions
}

# ---------------------------------------------------------------------------
# Outputs — ARNs and names consumed by environment root modules and ECS
# service definitions
# ---------------------------------------------------------------------------

output "domain_events_queue_url" {
  value       = aws_sqs_queue.domain_events.url
  description = "SQS FIFO queue URL for the domain-events queue. Inject as SQS_DOMAIN_EVENTS_QUEUE_URL in ECS task environments."
}

output "domain_events_queue_arn" {
  value       = aws_sqs_queue.domain_events.arn
  description = "SQS FIFO queue ARN for the domain-events queue."
}

output "domain_events_queue_name" {
  value       = aws_sqs_queue.domain_events.name
  description = "SQS FIFO queue name for the domain-events queue (used in CloudWatch alarms and autoscaling)."
}

output "domain_events_dlq_url" {
  value       = aws_sqs_queue.domain_events_dlq.url
  description = "SQS FIFO DLQ URL. Inject as SQS_DLQ_URL in ECS task environments."
}

output "domain_events_dlq_arn" {
  value       = aws_sqs_queue.domain_events_dlq.arn
  description = "SQS FIFO DLQ ARN."
}

output "sqs_kms_key_arn" {
  value       = aws_kms_key.domain_events_sqs.arn
  description = "ARN of the KMS CMK used to encrypt the domain-events SQS queues."
}

output "sqs_publisher_policy_arn" {
  value       = aws_iam_policy.sqs_publisher.arn
  description = "ARN of the IAM policy granting sqs:SendMessage to publishers."
}

output "sqs_consumer_policy_arn" {
  value       = aws_iam_policy.sqs_consumer.arn
  description = "ARN of the IAM policy granting consume operations to the notification-service."
}
