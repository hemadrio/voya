/**
 * monitoring-dashboards.tf — Four journey CloudWatch dashboards.
 *
 * Dashboards: Search | Checkout and Payment | Assistant | Platform Health
 *
 * Each dashboard shows:
 *   - p50/p95/p99 latency (from EMF metrics via ADOT)
 *   - Request rate
 *   - Server-fault rate (5xx %)
 *   - Dependency health
 *
 * The Platform Health dashboard includes the availability SLO widget with
 * an inline calculation description so any viewer can verify the math
 * without production data access.
 *
 * Metric references are validated at plan time: a reference to a metric
 * that does not exist will produce an empty widget at runtime but will NOT
 * fail plan.  Widget titles include the metric name to make empty widgets
 * loudly visible during post-deploy review.
 */

# ---------------------------------------------------------------------------
# Search Journey Dashboard
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "search" {
  dashboard_name = "${var.environment}-search-journey"

  dashboard_body = jsonencode({
    widgets = [
      # Row 1: Latency
      {
        type   = "metric"
        x      = 0; y = 0; width = 12; height = 6
        properties = {
          title  = "Search Latency (SearchResponseP{50,95,99}) — ms"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["${local.namespace_search}", "SearchResponseP50",  { stat = "p50", label = "p50", color = "#2ca02c" }],
            ["${local.namespace_search}", "SearchResponseP95",  { stat = "p95", label = "p95", color = "#ff7f0e" }],
            ["${local.namespace_search}", "SearchResponseP99",  { stat = "p99", label = "p99", color = "#d62728" }],
          ]
          yAxis = { left = { label = "ms", showUnits = false } }
          annotations = {
            horizontal = [
              { label = "p95 warning (${local.threshold_search_p95_warning_ms} ms)", value = local.threshold_search_p95_warning_ms, color = "#ff7f0e" },
              { label = "p95 hard (${local.threshold_search_p95_hard_ms} ms)", value = local.threshold_search_p95_hard_ms, color = "#d62728" },
            ]
          }
        }
      },
      # Row 1: Cache-hit latency
      {
        type   = "metric"
        x      = 12; y = 0; width = 12; height = 6
        properties = {
          title  = "Search Cache-Hit Latency (SearchCacheHitP95) — ms"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["${local.namespace_search}", "SearchCacheHitP95", { stat = "p95", label = "cache-hit p95", color = "#2ca02c" }],
          ]
          yAxis = { left = { label = "ms", showUnits = false } }
          annotations = {
            horizontal = [
              { label = "warning (${local.threshold_search_cache_p95_ms} ms)", value = local.threshold_search_cache_p95_ms, color = "#ff7f0e" },
            ]
          }
        }
      },
      # Row 2: Request rate and fault rate
      {
        type   = "metric"
        x      = 0; y = 6; width = 12; height = 6
        properties = {
          title  = "Search Request Rate (req/min)"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["${local.namespace_search}", "SearchRequestRate", { stat = "Sum", label = "requests/min" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12; y = 6; width = 12; height = 6
        properties = {
          title  = "Search Fault Rate (SearchFaultRate) — %"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 300
          metrics = [
            ["${local.namespace_search}", "SearchFaultRate", { stat = "Average", label = "fault rate %", color = "#d62728" }],
          ]
          annotations = {
            horizontal = [
              { label = "1% threshold", value = local.threshold_fault_rate_pct, color = "#d62728" },
            ]
          }
        }
      },
      # Row 3: Alarms
      {
        type   = "alarm"
        x      = 0; y = 12; width = 24; height = 3
        properties = {
          title  = "Search Alarm State"
          alarms = [
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.search_p95_hard.alarm_name}",
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.search_p95_warning.alarm_name}",
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.search_fault_rate.alarm_name}",
          ]
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Checkout and Payment Journey Dashboard
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "checkout" {
  dashboard_name = "${var.environment}-checkout-payment-journey"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0; y = 0; width = 12; height = 6
        properties = {
          title  = "Checkout Acknowledgement Latency (CheckoutAckP{50,95,99}) — ms"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["${local.namespace_checkout}", "CheckoutAckP50", { stat = "p50", label = "p50", color = "#2ca02c" }],
            ["${local.namespace_checkout}", "CheckoutAckP95", { stat = "p95", label = "p95", color = "#ff7f0e" }],
            ["${local.namespace_checkout}", "CheckoutAckP99", { stat = "p99", label = "p99", color = "#d62728" }],
          ]
          annotations = {
            horizontal = [
              { label = "p95 hard (${local.threshold_checkout_p95_ms} ms)", value = local.threshold_checkout_p95_ms, color = "#d62728" },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 12; y = 0; width = 12; height = 6
        properties = {
          title  = "Checkout Fault Rate (CheckoutFaultRate) — %"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 300
          metrics = [
            ["${local.namespace_checkout}", "CheckoutFaultRate", { stat = "Average", label = "fault rate %", color = "#d62728" }],
          ]
          annotations = {
            horizontal = [
              { label = "1% threshold", value = local.threshold_fault_rate_pct, color = "#d62728" },
            ]
          }
        }
      },
      # ALB native metrics
      {
        type   = "metric"
        x      = 0; y = 6; width = 12; height = 6
        properties = {
          title  = "ALB Response Time p95 (TargetResponseTime) — s"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix, { stat = "p95", label = "ALB p95" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12; y = 6; width = 12; height = 6
        properties = {
          title  = "ALB 5xx Count (HTTPCode_Target_5XX_Count)"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix, { stat = "Sum", label = "5xx/min", color = "#d62728" }],
          ]
        }
      },
      # Alarms
      {
        type   = "alarm"
        x      = 0; y = 12; width = 24; height = 3
        properties = {
          title  = "Checkout Alarm State"
          alarms = [
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.checkout_p95_hard.alarm_name}",
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.checkout_fault_rate.alarm_name}",
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.stripe_signature_failure.alarm_name}",
          ]
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Assistant Journey Dashboard
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "assistant" {
  dashboard_name = "${var.environment}-assistant-journey"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0; y = 0; width = 12; height = 6
        properties = {
          title  = "Assistant First-Token Latency (AssistantFirstTokenP{50,95,99}) — ms"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["${local.namespace_assistant}", "AssistantFirstTokenP50", { stat = "p50", label = "p50", color = "#2ca02c" }],
            ["${local.namespace_assistant}", "AssistantFirstTokenP95", { stat = "p95", label = "p95", color = "#ff7f0e" }],
            ["${local.namespace_assistant}", "AssistantFirstTokenP99", { stat = "p99", label = "p99", color = "#d62728" }],
          ]
          annotations = {
            horizontal = [
              { label = "p95 hard (${local.threshold_assistant_p95_ms} ms)", value = local.threshold_assistant_p95_ms, color = "#d62728" },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 12; y = 0; width = 12; height = 6
        properties = {
          title  = "Assistant Fault Rate (AssistantFaultRate) — %"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 300
          metrics = [
            ["${local.namespace_assistant}", "AssistantFaultRate", { stat = "Average", label = "fault rate %", color = "#d62728" }],
          ]
          annotations = {
            horizontal = [
              { label = "1% threshold", value = local.threshold_fault_rate_pct, color = "#d62728" },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 0; y = 6; width = 12; height = 6
        properties = {
          title  = "Assistant Request Rate (req/min)"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["${local.namespace_assistant}", "AssistantRequestRate", { stat = "Sum", label = "requests/min" }],
          ]
        }
      },
      {
        type   = "alarm"
        x      = 0; y = 12; width = 24; height = 3
        properties = {
          title  = "Assistant Alarm State"
          alarms = [
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.assistant_first_token_p95.alarm_name}",
          ]
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Platform Health Dashboard
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "platform_health" {
  dashboard_name = "${var.environment}-platform-health"

  dashboard_body = jsonencode({
    widgets = [
      # Availability SLO widget
      # Calculation: availability = (RequestCount - 5xxCount) / RequestCount * 100
      # Monthly objective: 99.5% (0.5% error budget = ~216 min/month)
      # Fast-burn threshold: 7.2% error rate in 1h (2% of monthly budget)
      # Slow-burn threshold: 3.0% error rate in 6h (5% of monthly budget)
      {
        type   = "metric"
        x      = 0; y = 0; width = 24; height = 6
        properties = {
          title  = "Availability SLO — target 99.5% monthly | Error rate = 5xx / total * 100 | Fast-burn >7.2% (1h), Slow-burn >3% (6h)"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 300
          metrics = [
            [{ expression = "IF(m1 > 0, (1 - m2/m1) * 100, 100)", label = "Availability (%)", id = "availability", color = "#2ca02c" }],
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { id = "m1", visible = false, stat = "Sum" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix, { id = "m2", visible = false, stat = "Sum" }],
          ]
          annotations = {
            horizontal = [
              { label = "SLO target (99.5%)", value = local.threshold_availability_pct, color = "#2ca02c", fill = "below" },
            ]
          }
          yAxis = { left = { min = 95, max = 100 } }
        }
      },
      # ALB healthy host count (deep health signal)
      {
        type   = "metric"
        x      = 0; y = 6; width = 12; height = 6
        properties = {
          title  = "ALB Healthy Host Count"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", var.alb_target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix, { stat = "Minimum", label = "healthy hosts" }],
          ]
        }
      },
      # SQS notification queue
      {
        type   = "metric"
        x      = 12; y = 6; width = 12; height = 6
        properties = {
          title  = "Notification Queue Depth and Message Age"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 60
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.notification_queue_name, { stat = "Maximum", label = "visible messages", color = "#ff7f0e" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", var.notification_queue_name, { stat = "Maximum", label = "oldest msg age (s)", yAxis = "right", color = "#d62728" }],
          ]
          annotations = {
            horizontal = [
              { label = "depth threshold (${local.threshold_queue_depth})", value = local.threshold_queue_depth, color = "#ff7f0e" },
            ]
          }
        }
      },
      # Security metrics
      {
        type   = "metric"
        x      = 0; y = 12; width = 12; height = 6
        properties = {
          title  = "Security Events (AuthFailures | AccessDenied | StripeSignatureFailures)"
          view   = "timeSeries"
          region = data.aws_region.current.name
          period = 300
          metrics = [
            ["${local.namespace_platform}", "AuthFailures",             { stat = "Sum", label = "auth failures", color = "#d62728" }],
            ["${local.namespace_platform}", "AccessDenied",             { stat = "Sum", label = "access denied", color = "#ff7f0e" }],
            ["${local.namespace_platform}", "StripeSignatureFailures",  { stat = "Sum", label = "stripe sig failures", color = "#9467bd" }],
            ["${local.namespace_platform}", "IllustrativeExposureUnflagged", { stat = "Sum", label = "illustrative exposures", color = "#8c564b" }],
          ]
        }
      },
      # Composite alarms
      {
        type   = "alarm"
        x      = 12; y = 12; width = 12; height = 6
        properties = {
          title  = "Composite Alarms (Platform Degradation + Latency)"
          alarms = [
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_composite_alarm.platform_degradation.alarm_name}",
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_composite_alarm.latency_degradation.alarm_name}",
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.availability_slo_fast_burn.alarm_name}",
            "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:${aws_cloudwatch_metric_alarm.availability_slo_slow_burn.alarm_name}",
          ]
        }
      },
    ]
  })
}
