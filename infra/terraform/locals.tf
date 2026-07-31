/**
 * locals.tf — Ratified SLO thresholds and shared metric/log configuration.
 *
 * Every numeric threshold for alarms and dashboards is defined exactly once here.
 * No threshold value may appear in alarm resources or dashboard widgets without
 * referencing a local defined below.
 *
 * WO-011 constraint: only the ratified numbers below may be used; no threshold
 * may be invented or re-estimated during implementation.
 */

locals {
  # ---------------------------------------------------------------------------
  # Ratified latency thresholds (milliseconds)
  # ---------------------------------------------------------------------------

  # Search latency — warning at p95 (3.0 s), hard alarm above 5.0 s
  threshold_search_p95_warning_ms = 3000
  threshold_search_p95_hard_ms    = 5000

  # Cache-hit search path — warning when p95 exceeds 180 ms
  # (this legitimately breaches during Redis outage; runbook distinguishes modes)
  threshold_search_cache_p95_ms = 180

  # ---------------------------------------------------------------------------
  # Search degradation — WO-038
  # ---------------------------------------------------------------------------

  # Stale-serve rate threshold — alarm when stale serves exceed 20% of total cache responses
  # A sustained high stale-serve rate indicates the cache freshness windows are too short
  # or the background-refresh pipeline is falling behind under load.
  threshold_stale_serve_rate_pct = 20.0

  # Cache unavailability sustained period — 5-minute evaluation window
  # Any non-zero unavailability count over this window triggers the alarm.
  threshold_cache_unavailable_count = 0

  # Supplier timeout — healthy 2200 ms, degraded 1500 ms (must match service config)
  supplier_timeout_healthy_ms  = 2200
  supplier_timeout_degraded_ms = 1500

  # Checkout acknowledgement — hard alarm above 5.0 s p95
  threshold_checkout_p95_ms = 5000

  # Assistant first-token latency — hard alarm above 2.0 s p95
  threshold_assistant_p95_ms = 2000

  # ---------------------------------------------------------------------------
  # Fault-rate thresholds
  # ---------------------------------------------------------------------------

  # Server-fault rate — alarm when 5xx exceeds 1.0 percent of requests
  # Evaluated per journey so a single supplier path is distinguishable from
  # a platform-wide fault.
  threshold_fault_rate_pct = 1.0

  # ---------------------------------------------------------------------------
  # Availability SLO — 99.5 percent monthly objective
  # ---------------------------------------------------------------------------

  threshold_availability_pct = 99.5

  # Error-budget burn-rate thresholds derived from the 99.5% monthly objective.
  #
  # Fast-burn (1-hour window):
  #   Consumes 2% of monthly budget in 1 hour.
  #   Burn rate = (monthly_minutes / 60) * (budget_fraction_consumed / window_hours)
  #             = (43200 / 60) * (0.02 / 1) = 14.4×
  #   Error rate threshold = 14.4 × (1 - 0.995) = 7.2%
  #
  # Slow-burn (6-hour window):
  #   Consumes 5% of monthly budget in 6 hours.
  #   Burn rate = (43200 / 360) * (0.05 / 1) = 6×
  #   Error rate threshold = 6 × 0.005 = 3.0%
  slo_fast_burn_error_rate_pct = 7.2
  slo_slow_burn_error_rate_pct = 3.0

  # ---------------------------------------------------------------------------
  # Operational thresholds
  # ---------------------------------------------------------------------------

  # SQS queue depth — alarm when visible messages exceed 100
  threshold_queue_depth = 100

  # Oldest SQS message age — alarm when any message is older than 300 s (5 min)
  # This is the proxy for notification delivery falling below 99% within 5 min.
  threshold_queue_oldest_msg_seconds = 300

  # ALB step-scaling trigger — RequestCountPerTarget per 2-minute evaluation window
  threshold_alb_request_count_per_target = 1000

  # ---------------------------------------------------------------------------
  # Metric namespaces (journey-level EMF metrics via ADOT)
  # ---------------------------------------------------------------------------

  namespace_search    = "travel/search"
  namespace_checkout  = "travel/checkout"
  namespace_assistant = "travel/assistant"
  namespace_platform  = "travel/platform"

  # ---------------------------------------------------------------------------
  # Application log groups (Pino JSON structured logs, per environment)
  # ---------------------------------------------------------------------------

  log_group_booking      = "/ecs/${var.environment}/booking-service"
  log_group_search       = "/ecs/${var.environment}/search-service"
  log_group_user         = "/ecs/${var.environment}/user-service"
  log_group_assistant    = "/ecs/${var.environment}/assistant-service"
  log_group_notification = "/ecs/${var.environment}/notification-service"
  log_group_payment      = "/ecs/${var.environment}/payment-service"
  log_group_adot         = "/ecs/${var.environment}/adot-collector"

  # ---------------------------------------------------------------------------
  # SNS severity action sets (populated in sns.tf)
  # ---------------------------------------------------------------------------

  platform_page_actions   = [aws_sns_topic.platform_page.arn]
  platform_ticket_actions = [aws_sns_topic.platform_ticket.arn]
  platform_info_actions   = [aws_sns_topic.platform_info.arn]
}
