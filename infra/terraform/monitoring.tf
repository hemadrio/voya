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

# ===========================================================================
# WO-107: Assistant cost governance alarms
#
# Metrics emitted by the CostMeteringService scheduled job via EMF.
# Namespace: travel/assistant
# Dimensions: environment, model (both low-cardinality; never conversationId).
#
# All thresholds are defined in locals.tf.
# Severity mapping:
#   USD 0.60/booking warning → HIGH  (platform_ticket)
#   USD 0.75/booking critical → CRITICAL (platform_page)
#   Cap breach rate           → HIGH  (platform_ticket)
#   Metering heartbeat absent → HIGH  (platform_ticket)
#   Metering degraded         → HIGH  (platform_ticket)
# ===========================================================================

# ---------------------------------------------------------------------------
# Threshold locals for assistant cost governance
# (appended to locals block via separate resource to avoid editing existing block)
# ---------------------------------------------------------------------------

locals {
  assistant_namespace = "travel/assistant"

  # USD 0.75 per completed booking is the platform ceiling (BR-cost-01).
  # Warning fires at 80% (USD 0.60); critical fires at 100% (USD 0.75).
  threshold_assistant_cost_per_booking_warning_usd  = 0.60
  threshold_assistant_cost_per_booking_critical_usd = 0.75

  # Cap breach rate: alarm when more than this fraction of turns breach a cap.
  threshold_assistant_cap_breach_rate = 0.10

  # Metering heartbeat: alarm when no heartbeat within 2 reporting periods.
  # The metering job runs every 15 minutes; 2 periods = 30 minutes.
  assistant_heartbeat_period_seconds = 1800
}

# ---------------------------------------------------------------------------
# WARNING alarm: cost per completed booking ≥ USD 0.60 (80% of ceiling)
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "assistant_cost_per_booking_warning" {
  alarm_name          = "HIGH-assistant-cost-per-booking-warning"
  alarm_description   = "Assistant spend per completed booking exceeded USD 0.60 (80% of USD 0.75 ceiling). Review conversation lengths and tool call patterns."

  namespace           = local.assistant_namespace
  metric_name         = "assistant_cost_per_completed_booking_usd"
  statistic           = "Average"
  period              = 900   # 15-minute job interval
  evaluation_periods  = 3
  datapoints_to_alarm = 2     # 2 of 3 consecutive periods

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.threshold_assistant_cost_per_booking_warning_usd
  treat_missing_data  = "notBreaching" # zero confirmed bookings → no-data, not alarm

  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions

  tags = {
    Severity  = "HIGH"
    Component = "assistant"
    WO        = "WO-107"
  }
}

# ---------------------------------------------------------------------------
# CRITICAL alarm: cost per completed booking ≥ USD 0.75 (ceiling breach)
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "assistant_cost_per_booking_critical" {
  alarm_name          = "CRITICAL-assistant-cost-per-booking-ceiling-breach"
  alarm_description   = "CRITICAL: Assistant spend per completed booking has reached or exceeded the USD 0.75 platform ceiling. Immediate review required."

  namespace           = local.assistant_namespace
  metric_name         = "assistant_cost_per_completed_booking_usd"
  statistic           = "Average"
  period              = 900
  evaluation_periods  = 2
  datapoints_to_alarm = 2

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.threshold_assistant_cost_per_booking_critical_usd
  treat_missing_data  = "notBreaching"

  alarm_actions = local.platform_page_actions
  ok_actions    = local.platform_page_actions

  tags = {
    Severity  = "CRITICAL"
    Component = "assistant"
    WO        = "WO-107"
  }
}

# ---------------------------------------------------------------------------
# Log metric filter: per-conversation cap breaches (8 tool calls or 60k tokens)
# Logged at WARN by CostGovernor.reconcile with conversationId and correlationId.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "assistant_cap_breach" {
  name           = "assistant-cap-breach"
  log_group_name = local.log_group_assistant
  pattern        = "{ $.event = \"cost_governor.cap_breach\" }"

  metric_transformation {
    name      = "assistant_cap_breach_count"
    namespace = local.assistant_namespace
    value     = "1"
  }
}

# HIGH alarm: cap breach rate — fires when ≥ 10% of turns breach a cap
resource "aws_cloudwatch_metric_alarm" "assistant_cap_breach_rate" {
  alarm_name          = "HIGH-assistant-cap-breach-rate"
  alarm_description   = "More than 10% of assistant turns are breaching per-conversation caps (tool calls or tokens). Investigate conversation patterns."

  namespace           = local.assistant_namespace
  metric_name         = "assistant_cap_breach_count"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 3
  datapoints_to_alarm = 2

  comparison_operator = "GreaterThanThreshold"
  # 10% of expected ~50 turns per 15-min period = 5 breaches
  threshold           = 5
  treat_missing_data  = "notBreaching"

  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions

  tags = {
    Severity  = "HIGH"
    Component = "assistant"
    WO        = "WO-107"
  }
}

# ---------------------------------------------------------------------------
# Metering heartbeat absence alarm (AC6 — fail closed on metering failure)
# The scheduled job emits assistant_metering_heartbeat once per run.
# Absence means the job has not run within the expected window.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "assistant_metering_heartbeat_absent" {
  alarm_name          = "HIGH-assistant-metering-heartbeat-absent"
  alarm_description   = "The assistant cost metering job has not published a heartbeat in the expected window. Cost-per-booking metric may be stale."

  namespace           = local.assistant_namespace
  metric_name         = "assistant_metering_heartbeat"
  statistic           = "Sum"
  period              = local.assistant_heartbeat_period_seconds
  evaluation_periods  = 1

  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching" # absence = alarm, not green

  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions

  tags = {
    Severity  = "HIGH"
    Component = "assistant"
    WO        = "WO-107"
  }
}

# ---------------------------------------------------------------------------
# Metering degraded alarm (AC6 — store/publisher unavailable)
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "assistant_metering_degraded_filter" {
  name           = "assistant-metering-degraded"
  log_group_name = local.log_group_assistant
  pattern        = "{ $.event = \"metering_attribution_failure\" || $.event = \"cost_record_store_failure\" }"

  metric_transformation {
    name      = "assistant_metering_degraded"
    namespace = local.assistant_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "assistant_metering_degraded" {
  alarm_name          = "HIGH-assistant-metering-degraded"
  alarm_description   = "The assistant cost metering pipeline is degraded (store or publisher unavailable). The cost-per-booking metric may be inaccurate. Pre-call caps remain enforced."

  namespace           = local.assistant_namespace
  metric_name         = "assistant_metering_degraded"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  datapoints_to_alarm = 1

  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions

  tags = {
    Severity  = "HIGH"
    Component = "assistant"
    WO        = "WO-107"
  }
}

# ---------------------------------------------------------------------------
# WO-111: Operational metrics dashboard
#
# Instantiates the dashboard module with the environment-specific parameters.
# The dashboard body is generated by the module from a typed widget definition
# list; all metrics are validated against docs/measurement/METRIC_CATALOGUE.md
# by scripts/validate-dashboard-metrics.ts in the CI pipeline.
# ---------------------------------------------------------------------------

module "operational_dashboard" {
  source = "./modules/dashboard"

  environment    = var.environment
  aws_region     = data.aws_region.current.name
  aws_account_id = data.aws_caller_identity.current.account_id

  alb_arn_suffix              = var.alb_arn_suffix
  alb_target_group_arn_suffix = var.alb_target_group_arn_suffix
  notification_queue_name     = var.notification_queue_name

  # Threshold defaults match committed architecture numbers (locals.tf).
  # Override only if the architecture decision is formally revised.
  threshold_search_cache_p95_ms            = local.threshold_search_cache_p95_ms
  threshold_search_p95_warning_ms          = local.threshold_search_p95_warning_ms
  threshold_search_p95_hard_ms             = local.threshold_search_p95_hard_ms
  threshold_checkout_p95_ms               = local.threshold_checkout_p95_ms
  threshold_assistant_first_token_p95_ms  = local.threshold_assistant_p95_ms
  threshold_availability_pct              = local.threshold_availability_pct
  threshold_fault_rate_pct                = local.threshold_fault_rate_pct
  threshold_assistant_cost_per_booking_usd = local.threshold_assistant_cost_per_booking_critical_usd
}
