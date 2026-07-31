# monitoring.tf — CloudWatch alarms for index tuning and partition maintenance.
# WO-077: alarms for the audit-log partition maintenance health and
# booking write latency regression detection.
#
# WO-011 extension: application-level dashboards, SLO-driven alarms, security
# alarms, and log metric filters are in monitoring-alarms.tf,
# monitoring-dashboards.tf, and monitoring-log-filters.tf.
# Ratified thresholds are in locals.tf.
# SNS severity topics (platform-page, platform-ticket, platform-info) are in sns.tf.
# New alarms use local.platform_page_actions / platform_ticket_actions from locals.tf.

locals {
  # Namespace shared across booking operational alarms
  booking_alarm_namespace = "travel/booking"
  # Alarm actions: existing on-call SNS topic (legacy; new alarms use severity topics)
  alarm_actions = [var.oncall_sns_topic_arn]
}

# ---------------------------------------------------------------------------
# Variable: on-call SNS topic ARN (injected per environment)
# ---------------------------------------------------------------------------

variable "oncall_sns_topic_arn" {
  description = "ARN of the SNS topic to notify on alarm state changes"
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Alarm: missing next-month partition
#
# The PartitionMaintenance task emits a structured warning log with
# event=partition.missing_next and alertable=true when the next month's
# partition does not exist ahead of need.  A CloudWatch Logs metric filter
# captures this pattern and publishes a metric that triggers this alarm.
#
# Threshold: any single occurrence of the pattern within 5 minutes.
# This gives a lead time of at least the pre-create window (3 months default)
# minus the polling period before inserts start failing.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "audit_partition_missing" {
  name           = "audit-partition-missing-next"
  log_group_name = "/aws/ecs/booking-service"
  pattern        = "{ $.event = \"partition.missing_next\" }"

  metric_transformation {
    name          = "AuditPartitionMissingNext"
    namespace     = local.booking_alarm_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_partition_missing" {
  alarm_name          = "audit-log-partition-missing-next-month"
  alarm_description   = "Next month's booking_audit_log partition is not pre-created. Inserts may land in the default partition. Investigate PartitionMaintenance task."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuditPartitionMissingNext"
  namespace           = local.booking_alarm_namespace
  period              = 300 # 5 minutes
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Alarm: partition maintenance error
#
# Fires when the maintenance task fails to create or detach a partition.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "partition_maintenance_error" {
  name           = "partition-maintenance-error"
  log_group_name = "/aws/ecs/booking-service"
  pattern        = "{ $.event = \"partition.maintenance.error\" || $.event = \"partition.create.error\" || $.event = \"partition.detach.error\" }"

  metric_transformation {
    name          = "PartitionMaintenanceErrors"
    namespace     = local.booking_alarm_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "partition_maintenance_error" {
  alarm_name          = "audit-log-partition-maintenance-error"
  alarm_description   = "Partition maintenance task encountered errors. Review partition_maintenance_error log events."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "PartitionMaintenanceErrors"
  namespace           = local.booking_alarm_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Alarm: booking write latency regression
#
# The index additions in migration 0006 add write amplification to the
# bookings table. This alarm fires if INSERT latency p95 exceeds the
# checkout acknowledgement budget (5 s).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "booking_write_latency" {
  alarm_name          = "booking-insert-latency-p95"
  alarm_description   = "booking INSERT p95 latency exceeds 500 ms — possible write-amplification regression from new indexes. Review index-and-partitioning-report.md."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "BookingInsertLatencyP95"
  namespace           = local.booking_alarm_namespace
  period              = 60
  extended_statistic  = "p95"
  threshold           = 500 # ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Alarm: search p95 regression
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "search_p95_regression" {
  alarm_name          = "search-response-p95"
  alarm_description   = "search endpoint p95 latency > 3000 ms — SLA breach. Investigate query plans and index health."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "SearchResponseP95"
  namespace           = "travel/search"
  period              = 60
  extended_statistic  = "p95"
  threshold           = 3000
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Retention Purge Worker Alarms (namespace: travel/purge)
# ---------------------------------------------------------------------------

locals {
  purge_alarm_namespace = "travel/purge"
}

# Alarm: category-level failure (non-zero failures counter)
resource "aws_cloudwatch_metric_alarm" "purge_category_failure" {
  alarm_name          = "purge-category-failure"
  alarm_description   = "One or more retention purge categories failed. Check /ecs/retention-worker logs. Non-zero exit means policy A10 triggered. Investigate immediately."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "purge_category_failures_total"
  namespace           = local.purge_alarm_namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# Alarm: zero-progress — run completed but nothing was purged (possible configuration drift)
resource "aws_cloudwatch_metric_alarm" "purge_zero_progress" {
  alarm_name          = "purge-zero-progress"
  alarm_description   = "Retention purge run completed with zero rows purged for 7 consecutive days. Possible configuration error, dead queue, or all data already purged. Verify."
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 7
  metric_name         = "purge_rows_purged_total"
  namespace           = local.purge_alarm_namespace
  period              = 86400
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
}

# Alarm: overlong run — purge taking more than 4 hours signals a stuck sweep
resource "aws_cloudwatch_metric_alarm" "purge_overlong_run" {
  alarm_name          = "purge-overlong-run"
  alarm_description   = "Retention purge category sweep exceeded 14400000 ms (4 hours). Possible runaway batch loop or DB issue. Investigate and terminate if needed."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "purge_category_duration_ms"
  namespace           = local.purge_alarm_namespace
  period              = 3600
  extended_statistic  = "p99"
  threshold           = 14400000 # 4 hours in ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# Alarm: run not started in 25 hours (EventBridge schedule missed)
resource "aws_cloudwatch_metric_alarm" "purge_run_not_started" {
  alarm_name          = "purge-run-not-started"
  alarm_description   = "No purge run started in the last 25 hours. EventBridge schedule may have failed or the task is not starting. Check ECS events and scheduler logs."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "purge_runs_started_total"
  namespace           = local.purge_alarm_namespace
  period              = 90000 # 25 hours
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
}
