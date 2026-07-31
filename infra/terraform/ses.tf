/**
 * Amazon SES configuration for transactional email delivery.
 *
 * Provisions:
 *   - SES email identity (domain verification)
 *   - SES configuration set with event destinations (CloudWatch)
 *   - SNS topic for bounce and complaint notifications
 *   - SQS queue subscribed to SNS for async bounce/complaint processing
 *   - Email templates for confirmation, cancellation, and modification
 *
 * DKIM records and SPF records are output so they can be added to the
 * DNS zone outside Terraform (or via Route53 if the zone is managed here).
 */

# ---------------------------------------------------------------------------
# SES Domain Identity
# ---------------------------------------------------------------------------

resource "aws_ses_domain_identity" "travel" {
  domain = var.ses_from_domain
}

resource "aws_ses_domain_dkim" "travel" {
  domain = aws_ses_domain_identity.travel.domain
}

# ---------------------------------------------------------------------------
# SES Configuration Set — event publishing to CloudWatch + SNS
# ---------------------------------------------------------------------------

resource "aws_sesv2_configuration_set" "notifications" {
  configuration_set_name = var.ses_configuration_set_name

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  tags = merge(local.common_tags, {
    Service = "notification-service"
  })
}

resource "aws_sesv2_configuration_set_event_destination" "cloudwatch" {
  configuration_set_name = aws_sesv2_configuration_set.notifications.configuration_set_name
  event_destination_name = "cloudwatch-metrics"

  event_destination {
    cloud_watch_destination {
      dimension_configuration {
        default_dimension_value = "ses"
        dimension_name          = "service"
        dimension_value_source  = "MESSAGE_TAG"
      }
    }

    enabled = true

    matching_event_types = [
      "SEND",
      "DELIVERY",
      "BOUNCE",
      "COMPLAINT",
      "REJECT",
      "OPEN",
      "CLICK",
    ]
  }
}

# ---------------------------------------------------------------------------
# SNS Topic — bounce and complaint notifications from SES
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "ses_notifications" {
  name         = "${var.environment}-ses-notifications"
  display_name = "SES Bounce and Complaint Notifications"

  kms_master_key_id = var.sns_kms_key_arn

  tags = merge(local.common_tags, {
    Service = "notification-service"
    Purpose = "ses-bounce-complaint"
  })
}

# Allow SES to publish to this SNS topic
data "aws_iam_policy_document" "ses_sns_publish" {
  statement {
    sid    = "AllowSESPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ses_notifications.arn]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [var.aws_account_id]
    }
  }
}

resource "aws_sns_topic_policy" "ses_notifications" {
  arn    = aws_sns_topic.ses_notifications.arn
  policy = data.aws_iam_policy_document.ses_sns_publish.json
}

# ---------------------------------------------------------------------------
# SQS Queue — receives bounce/complaint events from SNS for async processing
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "ses_notifications" {
  name                      = "${var.environment}-ses-notifications.fifo"
  fifo_queue                = true
  content_based_deduplication = true
  visibility_timeout_seconds = 30
  message_retention_seconds  = 86400  # 1 day

  kms_master_key_id = var.sqs_kms_key_arn

  tags = merge(local.common_tags, {
    Service = "notification-service"
    Purpose = "ses-bounce-complaint"
  })
}

resource "aws_sns_topic_subscription" "ses_notifications_sqs" {
  topic_arn = aws_sns_topic.ses_notifications.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.ses_notifications.arn

  raw_message_delivery = true
}

data "aws_iam_policy_document" "ses_sqs_policy" {
  statement {
    sid    = "AllowSNSToSQS"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ses_notifications.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.ses_notifications.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "ses_notifications" {
  queue_url = aws_sqs_queue.ses_notifications.url
  policy    = data.aws_iam_policy_document.ses_sqs_policy.json
}

# ---------------------------------------------------------------------------
# SES Email Templates
# ---------------------------------------------------------------------------

resource "aws_ses_template" "booking_confirmation" {
  name    = "travel-booking-confirmation-v1"
  subject = "Your booking is confirmed — {{bookingId}}"
  html    = "<h1>Booking Confirmed</h1><p>Your booking {{bookingId}} has been confirmed.</p>"
  text    = "Booking Confirmed\nYour booking {{bookingId}} has been confirmed."
}

resource "aws_ses_template" "booking_cancellation" {
  name    = "travel-booking-cancellation-v1"
  subject = "Your booking has been cancelled — {{bookingId}}"
  html    = "<h1>Booking Cancelled</h1><p>Your booking {{bookingId}} has been cancelled.</p>"
  text    = "Booking Cancelled\nYour booking {{bookingId}} has been cancelled."
}

resource "aws_ses_template" "booking_modification" {
  name    = "travel-booking-modification-v1"
  subject = "Your booking has been updated — {{bookingId}}"
  html    = "<h1>Booking Updated</h1><p>Your booking {{bookingId}} has been updated.</p>"
  text    = "Booking Updated\nYour booking {{bookingId}} has been updated."
}

# ---------------------------------------------------------------------------
# SES bounce/complaint notification configuration
# ---------------------------------------------------------------------------

resource "aws_ses_identity_notification_topic" "bounce" {
  topic_arn                = aws_sns_topic.ses_notifications.arn
  notification_type        = "Bounce"
  identity                 = aws_ses_domain_identity.travel.domain
  include_original_headers = false
}

resource "aws_ses_identity_notification_topic" "complaint" {
  topic_arn                = aws_sns_topic.ses_notifications.arn
  notification_type        = "Complaint"
  identity                 = aws_ses_domain_identity.travel.domain
  include_original_headers = false
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "ses_domain_verification_token" {
  description = "SES domain verification TXT record value — add to DNS as _amazonses.<domain>"
  value       = aws_ses_domain_identity.travel.verification_token
  sensitive   = false
}

output "ses_dkim_tokens" {
  description = "DKIM CNAME record values — add three CNAME records to DNS"
  value       = aws_ses_domain_dkim.travel.dkim_tokens
  sensitive   = false
}

output "ses_sns_topic_arn" {
  description = "SNS topic ARN for SES bounce/complaint notifications"
  value       = aws_sns_topic.ses_notifications.arn
}

output "ses_notifications_queue_url" {
  description = "SQS queue URL for asynchronous bounce/complaint processing"
  value       = aws_sqs_queue.ses_notifications.url
}
