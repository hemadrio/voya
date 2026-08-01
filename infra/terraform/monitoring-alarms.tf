/**
 * monitoring-alarms.tf — Application-level CloudWatch alarms for WO-011.
 *
 * All numeric thresholds are sourced from locals.tf — no value is hard-coded.
 *
 * Severity:
 *   CRITICAL → platform_page_actions   (wakes on-call immediately)
 *   HIGH     → platform_ticket_actions (creates incident ticket)
 *   INFO     → platform_info_actions   (informational; no page)
 *
 * Evaluation strategy:
 *   Latency hard alarms:  3 of 5 datapoints at 1-minute periods (avoids flapping)
 *   Latency warning:      2 of 5 datapoints at 1-minute periods
 *   Security alarms:      1 of 1 datapoints (zero-tolerance)
 *   Availability SLO:     1 period matching the burn-rate window
 *
 * treat_missing_data:
 *   notBreaching — for traffic-dependent metrics (latency, request count)
 *   breaching    — only where absence genuinely indicates failure
 */

# ---------------------------------------------------------------------------
# Variables (ALB and SQS resource identifiers, injected per environment)
# ---------------------------------------------------------------------------

variable "alb_arn_suffix" {
  description = "ARN suffix of the application load balancer (used for ALB metrics)."
  type        = string
  default     = ""
}

variable "alb_target_group_arn_suffix" {
  description = "ARN suffix of the ALB target group (used for RequestCountPerTarget)."
  type        = string
  default     = ""
}

variable "notification_queue_name" {
  description = "Name of the SQS notification queue (used for queue-depth and age alarms)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# LATENCY ALARMS — Search journey
# ---------------------------------------------------------------------------

# Warning: search p95 > 3.0 s (SLO warning boundary)
resource "aws_cloudwatch_metric_alarm" "search_p95_warning" {
  alarm_name          = "HIGH-search-latency-p95-warning"
  alarm_description   = "Search p95 latency exceeded 3000 ms warning threshold. SLO degradation in progress. Investigate supplier performance and cache hit rate. Runbook: ${local.runbook_base_url}/search-latency-breach.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  metric_name         = "SearchResponseP95"
  namespace           = local.namespace_search
  period              = 60
  extended_statistic  = "p95"
  threshold           = local.threshold_search_p95_warning_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# Hard: search p95 > 5.0 s (hard budget breach)
resource "aws_cloudwatch_metric_alarm" "search_p95_hard" {
  alarm_name          = "CRITICAL-search-latency-p95-hard"
  alarm_description   = "Search p95 latency exceeded 5000 ms hard alarm threshold. SLO budget breach. Immediate investigation required. Runbook: ${local.runbook_base_url}/search-latency-breach.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  metric_name         = "SearchResponseP95"
  namespace           = local.namespace_search
  period              = 60
  extended_statistic  = "p95"
  threshold           = local.threshold_search_p95_hard_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# Cache-hit search path warning: p95 > 180 ms
# NOTE: This alarm WILL breach legitimately during a Redis outage when the
# service degrades to direct supplier calls.  The runbook directs on-call to
# check the Redis alarm as the primary signal before acting on this one.
resource "aws_cloudwatch_metric_alarm" "search_cache_p95_warning" {
  alarm_name          = "HIGH-search-cache-latency-p95-warning"
  alarm_description   = "Cache-hit search path p95 latency exceeded 180 ms. Possible Redis degradation causing fallback to supplier calls. Check Redis alarm first — degraded mode is expected during Redis outage. Runbook: ${local.runbook_base_url}/search-latency-breach.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  metric_name         = "SearchCacheHitP95"
  namespace           = local.namespace_search
  period              = 60
  extended_statistic  = "p95"
  threshold           = local.threshold_search_cache_p95_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# ---------------------------------------------------------------------------
# LATENCY ALARMS — Checkout journey
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "checkout_p95_hard" {
  alarm_name          = "CRITICAL-checkout-latency-p95"
  alarm_description   = "Checkout acknowledgement p95 latency exceeded 5000 ms. Payment path SLO breach. Runbook: ${local.runbook_base_url}/checkout-fault-rate.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  metric_name         = "CheckoutAckP95"
  namespace           = local.namespace_checkout
  period              = 60
  extended_statistic  = "p95"
  threshold           = local.threshold_checkout_p95_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# ---------------------------------------------------------------------------
# LATENCY ALARMS — Assistant journey
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "assistant_first_token_p95" {
  alarm_name          = "HIGH-assistant-first-token-p95"
  alarm_description   = "Assistant first-token latency p95 exceeded 2000 ms. AI response path degraded. Runbook: ${local.runbook_base_url}/search-latency-breach.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  metric_name         = "AssistantFirstTokenP95"
  namespace           = local.namespace_assistant
  period              = 60
  extended_statistic  = "p95"
  threshold           = local.threshold_assistant_p95_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# ---------------------------------------------------------------------------
# FAULT-RATE ALARMS — per journey (distinguishes supplier vs platform faults)
# ---------------------------------------------------------------------------

# Search fault rate > 1% (5xx over 5-minute window)
resource "aws_cloudwatch_metric_alarm" "search_fault_rate" {
  alarm_name          = "CRITICAL-search-fault-rate"
  alarm_description   = "Search journey 5xx fault rate exceeded 1.0 percent over 5 minutes. Distinguish platform fault (500) from supplier failure (502/504) in logs. Runbook: ${local.runbook_base_url}/search-latency-breach.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SearchFaultRate"
  namespace           = local.namespace_search
  period              = 300
  statistic           = "Average"
  threshold           = local.threshold_fault_rate_pct
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# Checkout fault rate > 1%
resource "aws_cloudwatch_metric_alarm" "checkout_fault_rate" {
  alarm_name          = "CRITICAL-checkout-fault-rate"
  alarm_description   = "Checkout journey 5xx fault rate exceeded 1.0 percent over 5 minutes. Payment path health degraded. Runbook: ${local.runbook_base_url}/checkout-fault-rate.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "CheckoutFaultRate"
  namespace           = local.namespace_checkout
  period              = 300
  statistic           = "Average"
  threshold           = local.threshold_fault_rate_pct
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# ALB-level 5xx fault rate from native metrics (cross-journey edge view)
resource "aws_cloudwatch_metric_alarm" "alb_5xx_fault_rate" {
  alarm_name          = "HIGH-alb-5xx-fault-rate"
  alarm_description   = "ALB HTTPCode_Target_5XX_Count exceeded 1.0 percent of total requests over 5 minutes. This is an edge-level view across all journeys. Runbook: ${local.runbook_base_url}/checkout-fault-rate.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = local.threshold_fault_rate_pct
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions

  metric_query {
    id          = "faultRate"
    expression  = "IF(requests > 0, faults/requests*100, 0)"
    label       = "5xx Fault Rate (%)"
    return_data = true
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  metric_query {
    id = "faults"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }
}

# ---------------------------------------------------------------------------
# AVAILABILITY SLO — error-budget burn alarms
#
# Derived from ALB healthy-host count and 2xx/5xx ratio.
# Monthly objective: 99.5%.  Error budget: 0.5% (~216 min/month).
# ---------------------------------------------------------------------------

# Fast-burn: 2% of monthly budget consumed in 1 hour
# Alarm if 1-hour error rate > 7.2%
resource "aws_cloudwatch_metric_alarm" "availability_slo_fast_burn" {
  alarm_name          = "CRITICAL-availability-slo-fast-burn"
  alarm_description   = "SLO fast-burn detected: error rate over 1 hour is consuming 2%+ of the monthly error budget (threshold 7.2%). At this rate the monthly 99.5% SLO will be exhausted in under 50 hours. Runbook: ${local.runbook_base_url}/availability-error-budget-burn.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = local.slo_fast_burn_error_rate_pct
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions

  metric_query {
    id          = "errorRate"
    expression  = "IF(m1 > 0, m2/m1*100, 0)"
    label       = "Error Rate (%) — 1h fast-burn"
    return_data = true
  }

  metric_query {
    id = "m1"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  metric_query {
    id = "m2"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }
}

# Slow-burn: 5% of monthly budget consumed in 6 hours
# Alarm if 6-hour error rate > 3%
resource "aws_cloudwatch_metric_alarm" "availability_slo_slow_burn" {
  alarm_name          = "HIGH-availability-slo-slow-burn"
  alarm_description   = "SLO slow-burn detected: error rate over 6 hours is consuming 5%+ of the monthly error budget (threshold 3%). Sustained degradation will exhaust the monthly 99.5% SLO. Runbook: ${local.runbook_base_url}/availability-error-budget-burn.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = local.slo_slow_burn_error_rate_pct
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions

  metric_query {
    id          = "errorRate"
    expression  = "IF(m1 > 0, m2/m1*100, 0)"
    label       = "Error Rate (%) — 6h slow-burn"
    return_data = true
  }

  metric_query {
    id = "m1"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 21600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  metric_query {
    id = "m2"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 21600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }
}

# ---------------------------------------------------------------------------
# SECURITY ALARMS — zero-tolerance
# ---------------------------------------------------------------------------

# Stripe webhook signature verification failure — any single failure pages
resource "aws_cloudwatch_metric_alarm" "stripe_signature_failure" {
  alarm_name          = "CRITICAL-stripe-signature-failure"
  alarm_description   = "Stripe webhook HMAC signature verification failure detected. Zero-tolerance: even one failure may indicate a replay attack or misconfigured webhook secret. A single failure from a known test source should still fire — triage using the runbook. Runbook: ${local.runbook_base_url}/stripe-signature-failure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "StripeSignatureFailures"
  namespace           = local.namespace_platform
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# Access-control (403) spike
resource "aws_cloudwatch_metric_alarm" "access_denied_spike" {
  alarm_name          = "HIGH-access-denied-spike"
  alarm_description   = "Access-control denial (403) spike detected (>= 50 in 5 minutes). Possible credential stuffing, misconfigured role, or brute-force enumeration. Runbook: ${local.runbook_base_url}/access-control-denial-spike.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AccessDenied"
  namespace           = local.namespace_platform
  period              = 300
  statistic           = "Sum"
  threshold           = 50
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# Authentication failure spike (credential stuffing signal)
resource "aws_cloudwatch_metric_alarm" "auth_failure_spike" {
  alarm_name          = "HIGH-auth-failure-spike"
  alarm_description   = "Authentication failure spike detected (>= 20 in 5 minutes). Possible credential stuffing or brute-force attack. Runbook: ${local.runbook_base_url}/auth-failure-spike.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuthFailures"
  namespace           = local.namespace_platform
  period              = 300
  statistic           = "Sum"
  threshold           = 20
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# Server-side validation failure spike
resource "aws_cloudwatch_metric_alarm" "validation_failure_spike" {
  alarm_name          = "HIGH-validation-failure-spike"
  alarm_description   = "Server-side validation failure spike detected (>= 100 in 5 minutes). Possible malformed client, contract mismatch, or fuzzing. Runbook: ${local.runbook_base_url}/validation-failure-spike.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ValidationFailures"
  namespace           = local.namespace_platform
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# Illustrative result exposure — zero-tolerance (CRITICAL)
resource "aws_cloudwatch_metric_alarm" "illustrative_exposure_log_filter" {
  alarm_name          = "CRITICAL-illustrative-exposure-unflagged-log"
  alarm_description   = "ILLUSTRATIVE_EXPOSURE_UNFLAGGED event detected in search service logs. An illustrative (non-bookable) result was exposed without an approved audit-logged flag. Zero-tolerance: any occurrence is an incident. Runbook: ${local.runbook_base_url}/illustrative-result-exposure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "IllustrativeExposureUnflagged"
  namespace           = local.namespace_platform
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# ---------------------------------------------------------------------------
# OPERATIONAL ALARMS
# ---------------------------------------------------------------------------

# SQS queue depth > 100 visible messages
resource "aws_cloudwatch_metric_alarm" "notification_queue_depth" {
  alarm_name          = "HIGH-notification-queue-depth"
  alarm_description   = "Notification SQS queue depth exceeded 100 visible messages. Consumer may be falling behind. Runbook: ${local.runbook_base_url}/notification-queue-backlog.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = local.threshold_queue_depth
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = var.notification_queue_name
  }
  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions
}

# SQS oldest message age > 300 s (5 min) — proxy for 99% delivery within 5 min
resource "aws_cloudwatch_metric_alarm" "notification_queue_oldest_message" {
  alarm_name          = "HIGH-notification-queue-oldest-message"
  alarm_description   = "Notification SQS queue has messages older than 300 seconds. Delivery within 5-minute SLO is at risk (99% target). Consumer may be stuck or underprovisioned. Runbook: ${local.runbook_base_url}/notification-queue-backlog.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = local.threshold_queue_oldest_msg_seconds
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = var.notification_queue_name
  }
  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions
}

# ADOT collector exporter failures
resource "aws_cloudwatch_metric_alarm" "adot_exporter_failure" {
  alarm_name          = "HIGH-adot-exporter-failure"
  alarm_description   = "ADOT collector exporter failure detected. Metrics and traces may not be reaching CloudWatch/X-Ray. Dashboard data will be stale. Runbook: ${local.runbook_base_url}/adot-collector-failure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "AdotExporterFailures"
  namespace           = local.namespace_platform
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# ALB RequestCountPerTarget — step-scaling trigger (2-minute window)
resource "aws_cloudwatch_metric_alarm" "alb_request_count_per_target" {
  alarm_name          = "INFO-alb-request-count-step-scaling"
  alarm_description   = "ALB RequestCountPerTarget exceeded ${local.threshold_alb_request_count_per_target} over 2 minutes. This feeds the step-scaling policy. Runbook: ${local.runbook_base_url}/alb-request-count-breach.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RequestCountPerTarget"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = local.threshold_alb_request_count_per_target
  treat_missing_data  = "notBreaching"
  dimensions = {
    TargetGroup  = var.alb_target_group_arn_suffix
    LoadBalancer = var.alb_arn_suffix
  }
  alarm_actions = local.platform_info_actions
  ok_actions    = local.platform_info_actions
}

# ---------------------------------------------------------------------------
# SEARCH DEGRADATION ALARMS — WO-038
#
# These alarms cover the multi-supplier-search epic reliability signals:
#   1. Circuit-breaker open transitions
#   2. Stale-serve rate
#   3. Cache unavailability (sustained)
#   4. Illustrative offer exposure in production (any count)
#   5. Search latency p95 by category (warn 3.0 s / hard 5.0 s)
# ---------------------------------------------------------------------------

# Circuit-breaker open transitions — any breach triggers a ticket (HIGH)
# Metric emitted by the supplier circuit-breaker (WO-029) as
# supplier_breaker_transitions_total{direction="open"}.
resource "aws_cloudwatch_metric_alarm" "search_breaker_open" {
  alarm_name          = "HIGH-search-supplier-breaker-open"
  alarm_description   = "Supplier circuit-breaker opened at least once in the last 5 minutes. A supplier is failing and requests are being short-circuited. Check supplier_breaker_transitions_total and supplier call outcomes in the search dashboard. Runbook: ${local.runbook_base_url}/search-degradation.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SupplierBreakerTransitionsTotal"
  namespace           = local.namespace_search
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# Stale-serve rate — alarm when stale serves exceed threshold over a 5-minute window
resource "aws_cloudwatch_metric_alarm" "search_stale_serve_rate" {
  alarm_name          = "HIGH-search-cache-stale-serve-rate"
  alarm_description   = "Search stale-serve rate exceeded ${local.threshold_stale_serve_rate_pct}% over 5 minutes. Background cache refresh may be falling behind supplier latency. Check cache freshness window configuration and background-refresh logs. Runbook: ${local.runbook_base_url}/search-degradation.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = local.threshold_stale_serve_rate_pct
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions

  metric_query {
    id          = "staleRate"
    expression  = "IF(cacheResponses > 0, staleServes/cacheResponses*100, 0)"
    label       = "Stale Serve Rate (%)"
    return_data = true
  }

  metric_query {
    id = "staleServes"
    metric {
      metric_name = "search_cache_stale_serves_total"
      namespace   = local.namespace_search
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "cacheResponses"
    metric {
      metric_name = "search_cache_hits_total"
      namespace   = local.namespace_search
      period      = 300
      stat        = "Sum"
    }
  }
}

# Cache unavailability — any search_cache_unavailable_total count over 5 minutes
resource "aws_cloudwatch_metric_alarm" "search_cache_unavailable" {
  alarm_name          = "CRITICAL-search-cache-unavailable"
  alarm_description   = "Redis cache unavailability detected: search_cache_unavailable_total > 0 in the last 5 minutes. Search has degraded to direct supplier calls with a tightened 1500ms timeout. Responses are labelled cacheAvailable:false. Verify Redis cluster health and check for connection pool exhaustion. Runbook: ${local.runbook_base_url}/search-degradation.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "search_cache_unavailable_total"
  namespace           = local.namespace_search
  period              = 300
  statistic           = "Sum"
  threshold           = local.threshold_cache_unavailable_count
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# Illustrative offer exposure — any illustrative_offers_served_total in production
# Zero-tolerance: any count indicates a non-bookable offer was served (WO-030).
resource "aws_cloudwatch_metric_alarm" "search_illustrative_offers_served" {
  alarm_name          = "CRITICAL-search-illustrative-offers-served"
  alarm_description   = "Illustrative (non-bookable) offers were served to clients: illustrative_offers_served_total > 0. Zero-tolerance in production. An illustrative result in a booking flow would result in a failed checkout. Immediately check search service logs for ILLUSTRATIVE provenance results. Runbook: ${local.runbook_base_url}/illustrative-result-exposure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "illustrative_offers_served_total"
  namespace           = local.namespace_search
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# Search latency p95 by category — WARNING (already exists at endpoint level, this is per-category)
resource "aws_cloudwatch_metric_alarm" "search_latency_p95_by_category_warning" {
  alarm_name          = "HIGH-search-latency-p95-by-category-warning"
  alarm_description   = "Search latency p95 by category exceeded ${local.threshold_search_p95_warning_ms}ms. One or more search categories (flights/hotels/cars) are degraded. Distinguish supplier latency from cache miss rate in the search dashboard. Runbook: ${local.runbook_base_url}/search-degradation.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  metric_name         = "SearchLatencyByCategory"
  namespace           = local.namespace_search
  period              = 60
  extended_statistic  = "p95"
  threshold           = local.threshold_search_p95_warning_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# Search latency p95 by category — HARD alert
resource "aws_cloudwatch_metric_alarm" "search_latency_p95_by_category_hard" {
  alarm_name          = "CRITICAL-search-latency-p95-by-category-hard"
  alarm_description   = "Search latency p95 by category exceeded ${local.threshold_search_p95_hard_ms}ms hard threshold. Immediate investigation required. This level indicates supplier failure, Redis outage without degraded-mode activation, or resource exhaustion. Runbook: ${local.runbook_base_url}/search-degradation.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  metric_name         = "SearchLatencyByCategory"
  namespace           = local.namespace_search
  period              = 60
  extended_statistic  = "p95"
  threshold           = local.threshold_search_p95_hard_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# ---------------------------------------------------------------------------
# SECRET STARTUP VALIDATION FAILURE — zero-tolerance (CRITICAL)
#
# Fires when any process fails to validate required secrets at startup.
# A startup validation failure means a service may be running with stale,
# missing, or invalid secret values — a security-critical condition.
# Defined in SLO spec §6, policy A09.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "secret_startup_validation_failure" {
  alarm_name          = "CRITICAL-secret-startup-validation-failure"
  alarm_description   = "Secret startup validation failure detected. A service failed to validate one or more required secrets at startup. The service may be running with stale or missing credentials. Zero-tolerance: any occurrence requires immediate triage. Runbook: ${local.runbook_base_url}/secret-startup-validation-failure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SecretStartupValidationFailures"
  namespace           = local.namespace_platform
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.platform_page_actions
  ok_actions          = local.platform_page_actions
}

# ---------------------------------------------------------------------------
# SLI FEED NO-DATA ALARMS — feed loss detection (HIGH)
#
# Every SLI metric must emit data continuously. A stale or absent feed is
# NEVER interpreted as compliance — it must raise an alarm.
# treat_missing_data = "breaching" ensures absence triggers the alarm.
# Defined in SLO spec §5 (No-Data Policy).
# ---------------------------------------------------------------------------

# No-data: search SLI feed (SearchResponseP95)
resource "aws_cloudwatch_metric_alarm" "sli_feed_no_data_search" {
  alarm_name          = "HIGH-sli-feed-no-data-search"
  alarm_description   = "No SearchResponseP95 data received in the last 5 minutes. SLI feed loss must not be interpreted as compliance. Verify the search-service ADOT sidecar is running and emitting metrics. Runbook: ${local.runbook_base_url}/sli-feed-no-data.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "SearchResponseP95"
  namespace           = local.namespace_search
  period              = 300
  statistic           = "SampleCount"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# No-data: checkout SLI feed (CheckoutAcknowledgementP95)
resource "aws_cloudwatch_metric_alarm" "sli_feed_no_data_checkout" {
  alarm_name          = "HIGH-sli-feed-no-data-checkout"
  alarm_description   = "No CheckoutAcknowledgementP95 data received in the last 5 minutes. SLI feed loss must not be interpreted as compliance. Verify the checkout-service ADOT sidecar is running and emitting metrics. Runbook: ${local.runbook_base_url}/sli-feed-no-data.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "CheckoutAcknowledgementP95"
  namespace           = local.namespace_checkout
  period              = 300
  statistic           = "SampleCount"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# No-data: assistant SLI feed (AssistantFirstTokenP95)
resource "aws_cloudwatch_metric_alarm" "sli_feed_no_data_assistant" {
  alarm_name          = "HIGH-sli-feed-no-data-assistant"
  alarm_description   = "No AssistantFirstTokenP95 data received in the last 5 minutes. SLI feed loss must not be interpreted as compliance. Verify the assistant-service ADOT sidecar is running and emitting metrics. Runbook: ${local.runbook_base_url}/sli-feed-no-data.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AssistantFirstTokenP95"
  namespace           = local.namespace_assistant
  period              = 300
  statistic           = "SampleCount"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.platform_ticket_actions
  ok_actions          = local.platform_ticket_actions
}

# No-data: availability SLI feed (ALB RequestCount)
resource "aws_cloudwatch_metric_alarm" "sli_feed_no_data_availability" {
  alarm_name          = "HIGH-sli-feed-no-data-availability"
  alarm_description   = "No RequestCount data from ALB in the last 5 minutes. Availability SLI feed loss must not be interpreted as healthy. Verify the ALB is receiving traffic and metric publishing to CloudWatch is active. Runbook: ${local.runbook_base_url}/sli-feed-no-data.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "RequestCount"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "SampleCount"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }
  alarm_actions = local.platform_ticket_actions
  ok_actions    = local.platform_ticket_actions
}

# ---------------------------------------------------------------------------
# COMPOSITE ALARMS — dampen alarm storms during deployment rollbacks
#
# A composite alarm fires only when ALL constituent alarms are in ALARM state
# simultaneously, indicating a genuine platform-wide incident rather than a
# single-service deployment event.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_composite_alarm" "platform_degradation" {
  alarm_name        = "CRITICAL-platform-degradation-composite"
  alarm_description = "Composite: both search and checkout fault rates are elevated simultaneously. This indicates a platform-wide incident, not a single-service deployment issue. Runbook: ${local.runbook_base_url}/availability-error-budget-burn.md"

  alarm_rule = "ALARM(${aws_cloudwatch_metric_alarm.search_fault_rate.alarm_name}) AND ALARM(${aws_cloudwatch_metric_alarm.checkout_fault_rate.alarm_name})"

  alarm_actions = local.platform_page_actions
  ok_actions    = local.platform_page_actions
}

resource "aws_cloudwatch_composite_alarm" "latency_degradation" {
  alarm_name        = "HIGH-latency-degradation-composite"
  alarm_description = "Composite: search hard latency alarm and checkout latency alarm are both ALARM. This is a platform-wide latency incident rather than a single-service deployment. Runbook: ${local.runbook_base_url}/availability-error-budget-burn.md"

  alarm_rule = "ALARM(${aws_cloudwatch_metric_alarm.search_p95_hard.alarm_name}) AND ALARM(${aws_cloudwatch_metric_alarm.checkout_p95_hard.alarm_name})"

  alarm_actions = local.platform_page_actions
  ok_actions    = local.platform_page_actions
}
