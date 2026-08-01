# funnel-monitoring.tf — CloudWatch alarms for the funnel telemetry pipeline (WO-106 AC9, AC11).
#
# Three alarms guard the health of the pseudonymised conversion funnel emitter:
#
#   1. funnel_emitter_heartbeat_missing   — CRITICAL: heartbeat metric absent >2 periods
#      The emitter publishes a heartbeat to stdout (EMF) on every flush interval.
#      Absence means the emitter has stalled or the service is down.
#
#   2. funnel_events_dropped_total        — HIGH: dropped-event counter non-zero
#      The ring buffer drops the oldest event when full. Any drop in production
#      indicates the emitter is falling behind and the buffer needs tuning.
#
#   3. funnel_emission_failed_total       — HIGH: store write failures non-zero
#      The RDS insertBatch call failed. Events were re-queued but RDS may be
#      degraded. Investigate connection pool and RDS instance health.
#
# Metric names match the EMF keys emitted in StdoutEmfWriter (packages/observability).
# Dimensions: eventType=HEARTBEAT, category=HEARTBEAT, environment=<env>  (low-cardinality).
#
# All thresholds are intentionally conservative (any non-zero = alarm) to catch
# silent degradation early. Adjust treat_missing_data per environment needs.

locals {
  funnel_namespace       = "travel/funnel"
  funnel_log_group       = "/aws/ecs/booking-service"
  funnel_alarm_period_s  = 300  # 5 minutes — matches max flush interval × 2
}

# ---------------------------------------------------------------------------
# Metric filter: heartbeat presence
#
# The StdoutEmfWriter emits a structured EMF JSON line with
#   { "_aws": { "Namespace": "travel/funnel" }, "eventType": "HEARTBEAT",
#     "category": "HEARTBEAT", "funnel_emitter_heartbeat": 1 }
# on every flush cycle.  The filter captures this pattern and publishes the
# metric to CloudWatch so the alarm can detect absence.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "funnel_heartbeat" {
  name           = "funnel-emitter-heartbeat"
  log_group_name = local.funnel_log_group

  # EMF embedded metrics are serialised as JSON; match the heartbeat key.
  pattern = "{ $.funnel_emitter_heartbeat = * }"

  metric_transformation {
    name          = "funnel_emitter_heartbeat"
    namespace     = local.funnel_namespace
    value         = "$.funnel_emitter_heartbeat"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "funnel_heartbeat_missing" {
  alarm_name          = "CRITICAL-funnel-emitter-heartbeat-missing"
  alarm_description   = <<-EOT
    Funnel emitter heartbeat has been absent for 2 consecutive 5-minute periods.
    The emitter in booking-service may have stalled or the service is unhealthy.
    Check ECS task health and booking-service logs.
    Runbook: docs/runbooks/funnel-emitter-stalled.md
  EOT
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = "funnel_emitter_heartbeat"
  namespace           = local.funnel_namespace
  period              = local.funnel_alarm_period_s
  statistic           = "Sum"
  threshold           = 1
  # Missing heartbeat is genuinely alarming — treat as breaching.
  treat_missing_data  = "breaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_info_actions
}

# ---------------------------------------------------------------------------
# Metric filter: dropped events
#
# The emitter increments a counter each time it drops an event from the ring
# buffer. StdoutEmfWriter publishes this as funnel_events_dropped_total.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "funnel_events_dropped" {
  name           = "funnel-events-dropped"
  log_group_name = local.funnel_log_group
  pattern        = "{ $.funnel_events_dropped_total = * }"

  metric_transformation {
    name          = "funnel_events_dropped_total"
    namespace     = local.funnel_namespace
    value         = "$.funnel_events_dropped_total"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "funnel_events_dropped" {
  alarm_name          = "HIGH-funnel-events-dropped"
  alarm_description   = <<-EOT
    Funnel emitter dropped one or more events from the ring buffer.
    The buffer is full — the emitter is falling behind store write throughput.
    Consider increasing FUNNEL_BUFFER_SIZE or decreasing FUNNEL_FLUSH_INTERVAL_MS.
    Runbook: docs/runbooks/funnel-buffer-overflow.md
  EOT
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "funnel_events_dropped_total"
  namespace           = local.funnel_namespace
  period              = local.funnel_alarm_period_s
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_info_actions
}

# ---------------------------------------------------------------------------
# Metric filter: emission failures
#
# The emitter increments a counter each time an insertBatch call throws.
# The failed batch is re-queued so no events are lost on a transient failure,
# but persistent failures indicate an RDS connectivity issue.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "funnel_emission_failed" {
  name           = "funnel-emission-failed"
  log_group_name = local.funnel_log_group
  pattern        = "{ $.funnel_emission_failed_total = * }"

  metric_transformation {
    name          = "funnel_emission_failed_total"
    namespace     = local.funnel_namespace
    value         = "$.funnel_emission_failed_total"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "funnel_emission_failed" {
  alarm_name          = "HIGH-funnel-emission-failed"
  alarm_description   = <<-EOT
    Funnel emitter store write failed one or more times.
    Events are re-queued but RDS may be degraded or connection pool exhausted.
    Check RDS instance metrics (CPUUtilization, DatabaseConnections) and
    booking-service Prisma connection pool settings.
    Runbook: docs/runbooks/funnel-store-failures.md
  EOT
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "funnel_emission_failed_total"
  namespace           = local.funnel_namespace
  period              = local.funnel_alarm_period_s
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_info_actions
}
