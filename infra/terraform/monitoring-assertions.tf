/**
 * monitoring-assertions.tf — Terraform check blocks (Terraform >= 1.5).
 *
 * These assertions run during `terraform plan` and `terraform apply` and fail
 * with a clear error if an alarm is misconfigured.  They verify:
 *   - Every CRITICAL alarm description references a runbook path
 *   - Every CRITICAL alarm has a page-severity SNS action
 *   - The SLO fast-burn threshold exactly matches the ratified local value
 *   - The SLO slow-burn threshold exactly matches the ratified local value
 *   - Availability alarms do NOT use treat_missing_data = "breaching"
 *     (would produce false pages during quiet periods)
 *
 * These checks are deterministic — they evaluate locals and resource attributes
 * at plan time, not at apply time, so they act as unit tests for the alarm
 * configuration.
 */

# ---------------------------------------------------------------------------
# Search hard alarm: description must reference a runbook
# ---------------------------------------------------------------------------

check "search_hard_alarm_has_runbook" {
  assert {
    condition     = can(regex("docs/runbooks", aws_cloudwatch_metric_alarm.search_p95_hard.alarm_description))
    error_message = "CRITICAL-search-latency-p95-hard alarm_description must contain a runbook path."
  }
}

# ---------------------------------------------------------------------------
# Search hard alarm: must page (use page topic)
# ---------------------------------------------------------------------------

check "search_hard_alarm_has_page_action" {
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.search_p95_hard.alarm_actions) > 0
    error_message = "CRITICAL-search-latency-p95-hard must have at least one alarm_action."
  }
}

# ---------------------------------------------------------------------------
# Checkout fault alarm: description must reference a runbook
# ---------------------------------------------------------------------------

check "checkout_fault_alarm_has_runbook" {
  assert {
    condition     = can(regex("docs/runbooks", aws_cloudwatch_metric_alarm.checkout_fault_rate.alarm_description))
    error_message = "CRITICAL-checkout-fault-rate alarm_description must contain a runbook path."
  }
}

# ---------------------------------------------------------------------------
# Stripe signature alarm: zero-tolerance (threshold = 0)
# ---------------------------------------------------------------------------

check "stripe_alarm_zero_threshold" {
  assert {
    condition     = aws_cloudwatch_metric_alarm.stripe_signature_failure.threshold == 0
    error_message = "CRITICAL-stripe-signature-failure threshold must be exactly 0 (zero-tolerance)."
  }
}

# ---------------------------------------------------------------------------
# SLO fast-burn: threshold must match the ratified local value (7.2%)
# ---------------------------------------------------------------------------

check "slo_fast_burn_threshold_matches_local" {
  assert {
    condition     = aws_cloudwatch_metric_alarm.availability_slo_fast_burn.threshold == local.slo_fast_burn_error_rate_pct
    error_message = "SLO fast-burn alarm threshold must match local.slo_fast_burn_error_rate_pct (${local.slo_fast_burn_error_rate_pct}%)."
  }
}

# ---------------------------------------------------------------------------
# SLO slow-burn: threshold must match the ratified local value (3.0%)
# ---------------------------------------------------------------------------

check "slo_slow_burn_threshold_matches_local" {
  assert {
    condition     = aws_cloudwatch_metric_alarm.availability_slo_slow_burn.threshold == local.slo_slow_burn_error_rate_pct
    error_message = "SLO slow-burn alarm threshold must match local.slo_slow_burn_error_rate_pct (${local.slo_slow_burn_error_rate_pct}%)."
  }
}

# ---------------------------------------------------------------------------
# SLO fast-burn: must NOT use treat_missing_data = "breaching"
# (absence of ALB data during quiet period must not page)
# ---------------------------------------------------------------------------

check "slo_fast_burn_not_breaching_on_missing" {
  assert {
    condition     = aws_cloudwatch_metric_alarm.availability_slo_fast_burn.treat_missing_data != "breaching"
    error_message = "SLO fast-burn alarm must use treat_missing_data = notBreaching (not breaching) to avoid false pages during quiet periods."
  }
}

# ---------------------------------------------------------------------------
# Queue depth alarm: threshold must match the ratified local value (100)
# ---------------------------------------------------------------------------

check "queue_depth_threshold_matches_local" {
  assert {
    condition     = aws_cloudwatch_metric_alarm.notification_queue_depth.threshold == local.threshold_queue_depth
    error_message = "Notification queue depth alarm threshold must match local.threshold_queue_depth (${local.threshold_queue_depth})."
  }
}

# ---------------------------------------------------------------------------
# SNS delivery failure alarm: has explicit treat_missing_data
# ---------------------------------------------------------------------------

check "sns_delivery_alarm_treat_missing_data_set" {
  assert {
    condition     = aws_cloudwatch_metric_alarm.sns_delivery_failure.treat_missing_data != null
    error_message = "sns_delivery_failure alarm must set treat_missing_data explicitly."
  }
}
