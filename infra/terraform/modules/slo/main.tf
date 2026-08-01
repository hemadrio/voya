/**
 * modules/slo/main.tf — Reusable SLO alarm module.
 *
 * Emits four alarm types per SLO instantiation:
 *   1. Fast-burn alarm  — high burn rate over short window (CRITICAL / page)
 *   2. Slow-burn alarm  — lower burn rate over long window (HIGH / ticket)
 *   3. Hard-ceiling     — absolute threshold regardless of budget (CRITICAL / page)
 *      Optional: enabled only when var.hard_ceiling_threshold is non-null.
 *   4. No-data alarm    — feed absence treated as breaching (HIGH / ticket)
 *      Optional: enabled only when var.enable_no_data_alarm is true (default).
 *   5. Composite alarm  — fires when fast-burn AND slow-burn are both in ALARM.
 *      Suppresses single-alarm noise during deployment events.
 *
 * All alarms are Terraform resources. Console-configured alarms are rejected by
 * SOC 2 change-management policy (no change-evidence trail).
 *
 * Dimensions:
 *   - When var.alb_arn_suffix is non-empty the metric queries use an ALB dimension.
 *   - When empty, no dimension is applied (custom EMF metrics from ADOT).
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Local convenience values
# ---------------------------------------------------------------------------

locals {
  runbook_url = "${var.runbook_base_url}/${var.slo_name}"

  fast_burn_alarm_name = "CRITICAL-${var.slo_name}-slo-fast-burn"
  slow_burn_alarm_name = "HIGH-${var.slo_name}-slo-slow-burn"
  hard_ceiling_alarm_name = "CRITICAL-${var.slo_name}-slo-hard-ceiling"
  no_data_alarm_name   = "HIGH-${var.slo_name}-sli-feed-no-data"
  composite_alarm_name = "CRITICAL-${var.slo_name}-slo-composite"

  has_alb_dimension = var.alb_arn_suffix != ""
}

# ---------------------------------------------------------------------------
# 1. Fast-burn alarm
#
# Fires when the short-window error rate exceeds the fast-burn threshold.
# At this rate the monthly budget will be exhausted in under 50 hours.
# Severity: CRITICAL (page).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "fast_burn" {
  alarm_name          = local.fast_burn_alarm_name
  alarm_description   = "${var.slo_description} — fast-burn detected: ${var.fast_burn_window_seconds / 3600}-hour error rate > ${var.fast_burn_threshold_pct}% (${var.fast_burn_rate}× burn at ${var.slo_target * 100}% SLO). Runbook: ${local.runbook_url}-fast-burn.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = var.fast_burn_threshold_pct
  treat_missing_data  = "breaching"
  alarm_actions       = [var.page_alarm_arn]
  ok_actions          = [var.page_alarm_arn]

  metric_query {
    id          = "errorRate"
    expression  = "IF(m1 > 0, m2/m1*100, 0)"
    label       = "Error Rate (%) — ${var.fast_burn_window_seconds / 3600}h fast-burn"
    return_data = true
  }

  metric_query {
    id = "m1"
    metric {
      metric_name = "RequestCount"
      namespace   = var.namespace
      period      = var.fast_burn_window_seconds
      stat        = "Sum"

      dynamic "dimensions" {
        for_each = local.has_alb_dimension ? [1] : []
        content {
          LoadBalancer = var.alb_arn_suffix
        }
      }
    }
  }

  metric_query {
    id = "m2"
    metric {
      metric_name = var.metric_name
      namespace   = var.namespace
      period      = var.fast_burn_window_seconds
      stat        = "Sum"

      dynamic "dimensions" {
        for_each = local.has_alb_dimension ? [1] : []
        content {
          LoadBalancer = var.alb_arn_suffix
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------
# 2. Slow-burn alarm
#
# Fires when the long-window error rate exceeds the slow-burn threshold.
# Does not page alone; the composite alarm governs paging when both fire.
# Severity: HIGH (ticket).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "slow_burn" {
  alarm_name          = local.slow_burn_alarm_name
  alarm_description   = "${var.slo_description} — slow-burn detected: ${var.slow_burn_window_seconds / 3600}-hour error rate > ${var.slow_burn_threshold_pct}% (${var.slow_burn_rate}× burn at ${var.slo_target * 100}% SLO). Runbook: ${local.runbook_url}-slow-burn.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = var.slow_burn_threshold_pct
  treat_missing_data  = "breaching"
  alarm_actions       = [var.ticket_alarm_arn]
  ok_actions          = [var.ticket_alarm_arn]

  metric_query {
    id          = "errorRate"
    expression  = "IF(m1 > 0, m2/m1*100, 0)"
    label       = "Error Rate (%) — ${var.slow_burn_window_seconds / 3600}h slow-burn"
    return_data = true
  }

  metric_query {
    id = "m1"
    metric {
      metric_name = "RequestCount"
      namespace   = var.namespace
      period      = var.slow_burn_window_seconds
      stat        = "Sum"

      dynamic "dimensions" {
        for_each = local.has_alb_dimension ? [1] : []
        content {
          LoadBalancer = var.alb_arn_suffix
        }
      }
    }
  }

  metric_query {
    id = "m2"
    metric {
      metric_name = var.metric_name
      namespace   = var.namespace
      period      = var.slow_burn_window_seconds
      stat        = "Sum"

      dynamic "dimensions" {
        for_each = local.has_alb_dimension ? [1] : []
        content {
          LoadBalancer = var.alb_arn_suffix
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------
# 3. Hard-ceiling alarm (optional)
#
# Absolute threshold alarm independent of burn rate. Fires immediately when
# the raw metric crosses a hard limit, regardless of budget state.
# Severity: CRITICAL (page).
#
# Created only when var.hard_ceiling_threshold is set.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "hard_ceiling" {
  count = var.hard_ceiling_threshold != null ? 1 : 0

  alarm_name          = local.hard_ceiling_alarm_name
  alarm_description   = "${var.slo_description} — hard-ceiling breach: ${var.hard_ceiling_statistic} exceeded ${var.hard_ceiling_threshold}. Immediate investigation required regardless of budget state. Runbook: ${local.runbook_url}-hard-ceiling.md"
  comparison_operator = var.hard_ceiling_comparison
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  metric_name         = var.metric_name
  namespace           = var.namespace
  period              = var.hard_ceiling_period_seconds
  extended_statistic  = var.hard_ceiling_statistic
  threshold           = var.hard_ceiling_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.page_alarm_arn]
  ok_actions          = [var.page_alarm_arn]
}

# ---------------------------------------------------------------------------
# 4. No-data alarm
#
# Fires when the SLI feed goes silent. Absence of data is NEVER interpreted
# as compliance — it must page the team to investigate feed health.
# treat_missing_data is deliberately omitted from this alarm; the alarm logic
# fires purely on the data-absence period defined by var.no_data_period_seconds.
# Severity: HIGH (ticket).
#
# Created only when var.enable_no_data_alarm is true (default).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "no_data" {
  count = var.enable_no_data_alarm ? 1 : 0

  alarm_name          = local.no_data_alarm_name
  alarm_description   = "${var.slo_description} — SLI feed went silent: no ${var.metric_name} data in ${var.no_data_period_seconds / 60} minutes. A missing feed must not be interpreted as compliance. Verify the ADOT collector and metric emitters are healthy. Runbook: ${local.runbook_url}-no-data.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = var.metric_name
  namespace           = var.namespace
  period              = var.no_data_period_seconds
  statistic           = "SampleCount"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [var.ticket_alarm_arn]
  ok_actions          = [var.ticket_alarm_arn]
}

# ---------------------------------------------------------------------------
# 5. Composite alarm
#
# Fires only when BOTH fast-burn AND slow-burn alarms are in ALARM state
# simultaneously. This suppresses single-path noise during deployment rollback
# events and focuses paging on genuine correlated degradation.
# Severity: CRITICAL (page).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_composite_alarm" "slo_composite" {
  alarm_name        = local.composite_alarm_name
  alarm_description = "${var.slo_description} — composite SLO breach: both fast-burn (${local.fast_burn_alarm_name}) and slow-burn (${local.slow_burn_alarm_name}) alarms are firing simultaneously. This indicates sustained, correlated budget consumption. Runbook: ${local.runbook_url}-composite.md"

  alarm_rule = "ALARM(\"${local.fast_burn_alarm_name}\") AND ALARM(\"${local.slow_burn_alarm_name}\")"

  alarm_actions = [var.page_alarm_arn]
  ok_actions    = [var.page_alarm_arn]

  depends_on = [
    aws_cloudwatch_metric_alarm.fast_burn,
    aws_cloudwatch_metric_alarm.slow_burn,
  ]
}
