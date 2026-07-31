/**
 * sns.tf — SNS topics for platform alerting with distinct severities.
 *
 * Three topics map to operational escalation tiers:
 *   platform-page   — wakes on-call immediately (P1 alarms)
 *   platform-ticket — creates a Jira/incident ticket (P2 alarms)
 *   platform-info   — informational; no page or ticket required
 *
 * Delivery-failure alarm on the page topic ensures the alerting channel
 * itself is monitored — a broken SNS path is detected rather than assumed
 * working.
 *
 * On-call subscription endpoints are injected via variables so the actual
 * PagerDuty/Opsgenie integration URL is not committed to source control.
 */

# ---------------------------------------------------------------------------
# SNS Topics
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "platform_page" {
  name = "${var.environment}-platform-page"
  tags = local.common_tags
}

resource "aws_sns_topic" "platform_ticket" {
  name = "${var.environment}-platform-ticket"
  tags = local.common_tags
}

resource "aws_sns_topic" "platform_info" {
  name = "${var.environment}-platform-info"
  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Subscriptions — endpoints injected per environment
# ---------------------------------------------------------------------------

variable "oncall_page_endpoint" {
  description = "HTTPS endpoint (PagerDuty/Opsgenie) for paging alarms."
  type        = string
  default     = ""
}

variable "oncall_ticket_endpoint" {
  description = "HTTPS endpoint for ticket-creating alarms."
  type        = string
  default     = ""
}

resource "aws_sns_topic_subscription" "platform_page_subscription" {
  count     = var.oncall_page_endpoint != "" ? 1 : 0
  topic_arn = aws_sns_topic.platform_page.arn
  protocol  = "https"
  endpoint  = var.oncall_page_endpoint

  endpoint_auto_confirms = true
}

resource "aws_sns_topic_subscription" "platform_ticket_subscription" {
  count     = var.oncall_ticket_endpoint != "" ? 1 : 0
  topic_arn = aws_sns_topic.platform_ticket.arn
  protocol  = "https"
  endpoint  = var.oncall_ticket_endpoint

  endpoint_auto_confirms = true
}

# ---------------------------------------------------------------------------
# Delivery-failure alarm — monitors the SNS page topic itself
#
# NumberOfNotificationsFailed > 0 means the alerting channel is broken;
# this alarm routes to the ticket topic so delivery failure still creates
# an incident rather than silently dropping.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "sns_delivery_failure" {
  alarm_name          = "HIGH-sns-page-delivery-failure"
  alarm_description   = "SNS platform-page topic delivery failure detected. The on-call alerting path may be broken. Check SNS dead-letter queue and subscription health. Runbook: ${local.runbook_base_url}/sns-delivery-failure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "NumberOfNotificationsFailed"
  namespace           = "AWS/SNS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions = {
    TopicName = aws_sns_topic.platform_page.name
  }
  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "sns_platform_page_arn" {
  value       = aws_sns_topic.platform_page.arn
  description = "ARN of the paging-severity SNS topic."
}

output "sns_platform_ticket_arn" {
  value       = aws_sns_topic.platform_ticket.arn
  description = "ARN of the ticket-severity SNS topic."
}

output "sns_platform_info_arn" {
  value       = aws_sns_topic.platform_info.arn
  description = "ARN of the informational SNS topic."
}
