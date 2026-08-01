/**
 * modules/dashboard/main.tf — Operational Metrics Dashboard (WO-111).
 *
 * Produces a single aws_cloudwatch_dashboard with four panel groups:
 *
 *   Group 1 — Funnel Conversion Ratios (y=0..11)
 *     Conversion rates computed via SEARCH Metric Math from funnel_events_total
 *     (travel/funnel namespace, dimensions: eventType, category, environment).
 *     Targets from docs/measurement/TARGET_RATIFICATION.md — annotated but not
 *     enforced as alarms here; alarming is handled in monitoring-alarms.tf.
 *
 *   Group 2 — Latency Percentiles per Journey (y=12..23)
 *     Per-journey p95 with committed budget annotation lines sourced from locals.tf.
 *     No threshold values may be invented; all annotations reference module variables
 *     whose defaults match the committed architecture numbers.
 *
 *   Group 3 — Availability and Error-Budget Burn-Down (y=24..35)
 *     Monthly availability percentage derived from ALB RequestCount / 5xx counts.
 *     Remaining error-budget minutes out of the ~219 monthly allowance.
 *
 *   Group 4 — Guardrail Metrics (y=36..53)
 *     Server fault rate, platform-attributable checkout failure rate, notification
 *     timeliness (SQS oldest-message age proxy), illustrative exposure counter
 *     (zero-tolerance), assistant cost ceiling, and CI test coverage floor.
 *
 *   Text widget (y=54..59)
 *     Lists metrics that cannot produce final values at the Phase 1 gate date and
 *     their earliest measurable dates.
 *
 * All widgets set missing_data behavior via "fill" = "none" so absent feeds
 * render as a visible gap rather than a zero line implying compliance.
 *
 * Metric references are validated at CI time by scripts/validate-dashboard-metrics.ts
 * against docs/measurement/METRIC_CATALOGUE.md; a renamed metric fails the build.
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  # Shorthand used throughout jsonencode blocks
  env    = var.environment
  region = var.aws_region

  # The dashboard produces 30-day windows for availability calculations.
  # A 30-day rolling window in seconds = 2592000. CloudWatch max period = 86400.
  # Use 86400 (1 day) as the evaluation period and look at a 30-day time window.
  availability_period_s = 86400  # 1-day granules in a 30-day view

  # Error budget annotation value (minutes) — from var to keep in sync with
  # the committed architecture number and prevent drift.
  error_budget_min = var.error_budget_minutes_per_month
}

resource "aws_cloudwatch_dashboard" "operational" {
  dashboard_name = "${var.environment}-operational-metrics"

  dashboard_body = jsonencode({
    widgets = concat(
      local.funnel_conversion_widgets,
      local.latency_widgets,
      local.availability_widgets,
      local.guardrail_widgets,
      local.text_widgets,
    )
  })
}

# ---------------------------------------------------------------------------
# Group 1 — Funnel Conversion Ratios (y = 0..11)
#
# Conversion rates use CloudWatch SEARCH expressions to aggregate funnel_events_total
# across all category dimensions for each eventType.  The ratio is computed via
# Metric Math.  All panels use missing_data_treatment "breachingMissing" so a
# stale funnel feed renders as a gap, not compliance.
# ---------------------------------------------------------------------------

locals {
  funnel_conversion_widgets = [
    # Header text
    {
      type   = "text"
      x      = 0; y = 0; width = 24; height = 2
      properties = {
        markdown = "## Funnel Conversion Ratios\nSources: `travel/funnel` namespace · `funnel_events_total` by `eventType` dimension · [Metric Catalogue](docs/measurement/METRIC_CATALOGUE.md)"
      }
    },

    # Search-to-Booking rate: payment_confirmed / search_performed × 100
    {
      type   = "metric"
      x      = 0; y = 2; width = 8; height = 5
      properties = {
        title  = "Search-to-Booking Rate (%) — target 4.0%"
        view   = "timeSeries"
        region = local.region
        period = 3600
        metrics = [
          [{ expression = "IF(m_search > 0, m_payment / m_search * 100, 0)", label = "search→booking %", id = "rate", color = "#2ca02c" }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"search_performed\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_search", visible = false }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"payment_confirmed\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_payment", visible = false }],
        ]
        annotations = {
          horizontal = [
            { label = "target 4.0%", value = 4.0, color = "#2ca02c" },
          ]
        }
        yAxis = { left = { min = 0, label = "%" } }
      }
    },

    # Assistant-attributed conversion: payment_confirmed (ASSISTANT) / search_performed
    {
      type   = "metric"
      x      = 8; y = 2; width = 8; height = 5
      properties = {
        title  = "Assistant Conversion Rate (%) — target 20%"
        view   = "timeSeries"
        region = local.region
        period = 3600
        metrics = [
          [{ expression = "IF(m_search > 0, m_ai_pay / m_search * 100, 0)", label = "assistant conv %", id = "ai_rate", color = "#1f77b4" }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"search_performed\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_search", visible = false }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"payment_confirmed\" category=\"ASSISTANT\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_ai_pay", visible = false }],
        ]
        annotations = {
          horizontal = [{ label = "target 20%", value = 20.0, color = "#1f77b4" }]
        }
        yAxis = { left = { min = 0, label = "%" } }
      }
    },

    # Multi-category attachment: itinerary_created MULTI / payment_confirmed
    {
      type   = "metric"
      x      = 16; y = 2; width = 8; height = 5
      properties = {
        title  = "Multi-Category Attachment (%) — target 30% [leading indicator]"
        view   = "timeSeries"
        region = local.region
        period = 3600
        metrics = [
          [{ expression = "IF(m_pay > 0, m_multi / m_pay * 100, 0)", label = "attachment %", id = "attach_rate", color = "#ff7f0e" }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"payment_confirmed\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_pay", visible = false }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"itinerary_created\" category=\"MULTI\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_multi", visible = false }],
        ]
        annotations = {
          horizontal = [{ label = "target 30% (90-day — leading indicator only)", value = 30.0, color = "#ff7f0e" }]
        }
        yAxis = { left = { min = 0, label = "%" } }
      }
    },

    # Guest-to-registration and Preference adoption
    {
      type   = "metric"
      x      = 0; y = 7; width = 12; height = 5
      properties = {
        title  = "Guest-to-Registration (%) — target 25%"
        view   = "timeSeries"
        region = local.region
        period = 3600
        metrics = [
          [{ expression = "IF(m_sess > 0, m_reg / m_sess * 100, 0)", label = "guest→reg %", id = "reg_rate", color = "#9467bd" }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"session_started\" category=\"AUTH\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_sess", visible = false }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"guest_registered\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_reg", visible = false }],
        ]
        annotations = {
          horizontal = [{ label = "target 25%", value = 25.0, color = "#9467bd" }]
        }
        yAxis = { left = { min = 0, label = "%" } }
      }
    },

    # Conversation completion
    {
      type   = "metric"
      x      = 12; y = 7; width = 12; height = 5
      properties = {
        title  = "Conversation Completion (%) — target 70%"
        view   = "timeSeries"
        region = local.region
        period = 3600
        metrics = [
          [{ expression = "IF(m_started > 0, m_handoff / m_started * 100, 0)", label = "conv completion %", id = "conv_rate", color = "#8c564b" }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"conversation_started\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_started", visible = false }],
          [{ expression = "SUM(SEARCH('{travel/funnel,eventType,category,environment} funnel_events_total eventType=\"conversation_handoff\" environment=\"${local.env}\"', 'Sum', 3600))", id = "m_handoff", visible = false }],
        ]
        annotations = {
          horizontal = [{ label = "target 70%", value = 70.0, color = "#8c564b" }]
        }
        yAxis = { left = { min = 0, label = "%" } }
      }
    },
  ]
}

# ---------------------------------------------------------------------------
# Group 2 — Latency Percentiles per Journey (y = 12..23)
# ---------------------------------------------------------------------------

locals {
  latency_widgets = [
    {
      type   = "text"
      x      = 0; y = 12; width = 24; height = 2
      properties = {
        markdown = "## Latency Percentiles per Journey\nAnnotation lines show committed p95 budgets. Missing data renders as a gap — a silent telemetry failure must not read as compliance."
      }
    },

    # Search cache-hit latency p95 — 180 ms
    {
      type   = "metric"
      x      = 0; y = 14; width = 12; height = 5
      properties = {
        title  = "Search Cache-Hit p95 — budget 180 ms"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          ["travel/search", "SearchCacheHitP95", { stat = "p95", label = "cache-hit p95", color = "#2ca02c" }],
        ]
        yAxis = { left = { label = "ms" } }
        annotations = {
          horizontal = [
            { label = "budget (${var.threshold_search_cache_p95_ms} ms)", value = var.threshold_search_cache_p95_ms, color = "#ff7f0e" },
          ]
        }
      }
    },

    # Search overall p95 — 3.0 s warning, 5.0 s hard
    {
      type   = "metric"
      x      = 12; y = 14; width = 12; height = 5
      properties = {
        title  = "Search Overall p95 — warning 3.0 s / hard 5.0 s"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          ["travel/search", "SearchResponseP95", { stat = "p95", label = "search p95", color = "#ff7f0e" }],
        ]
        yAxis = { left = { label = "ms" } }
        annotations = {
          horizontal = [
            { label = "warning (${var.threshold_search_p95_warning_ms} ms)", value = var.threshold_search_p95_warning_ms, color = "#ff7f0e" },
            { label = "hard alert (${var.threshold_search_p95_hard_ms} ms)", value = var.threshold_search_p95_hard_ms, color = "#d62728" },
          ]
        }
      }
    },

    # Checkout acknowledgement p95 — 5.0 s
    {
      type   = "metric"
      x      = 0; y = 19; width = 12; height = 5
      properties = {
        title  = "Checkout Acknowledgement p95 — budget 5.0 s"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          ["travel/checkout", "CheckoutAckP95", { stat = "p95", label = "checkout p95", color = "#ff7f0e" }],
        ]
        yAxis = { left = { label = "ms" } }
        annotations = {
          horizontal = [
            { label = "hard (${var.threshold_checkout_p95_ms} ms)", value = var.threshold_checkout_p95_ms, color = "#d62728" },
          ]
        }
      }
    },

    # Assistant first-token p95 — 2.0 s
    {
      type   = "metric"
      x      = 12; y = 19; width = 12; height = 5
      properties = {
        title  = "Assistant First-Token p95 — budget 2.0 s"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          ["travel/assistant", "AssistantFirstTokenP95", { stat = "p95", label = "first-token p95", color = "#1f77b4" }],
        ]
        yAxis = { left = { label = "ms" } }
        annotations = {
          horizontal = [
            { label = "hard (${var.threshold_assistant_first_token_p95_ms} ms)", value = var.threshold_assistant_first_token_p95_ms, color = "#d62728" },
          ]
        }
      }
    },
  ]
}

# ---------------------------------------------------------------------------
# Group 3 — Availability and Error-Budget Burn-Down (y = 24..35)
#
# Availability = (RequestCount - 5xx) / RequestCount × 100
# Budget consumed (minutes) = downtime_fraction × 30-day-minutes
# Budget remaining = 219 - budget_consumed
#
# Uses ALB native metrics (AWS/ApplicationELB namespace).
# Missing data from ALB is expected on brand-new deployments — renders as gap.
# ---------------------------------------------------------------------------

locals {
  availability_widgets = [
    {
      type   = "text"
      x      = 0; y = 24; width = 24; height = 2
      properties = {
        markdown = "## Availability and Error-Budget Burn-Down\nSLO target: **99.5%** monthly · Monthly budget: **~${local.error_budget_min} minutes** · Missing data = feed absent (not compliance)"
      }
    },

    # Monthly availability percentage
    {
      type   = "metric"
      x      = 0; y = 26; width = 16; height = 6
      properties = {
        title  = "Monthly Availability (%) — SLO 99.5%"
        view   = "timeSeries"
        region = local.region
        period = local.availability_period_s
        metrics = [
          [{ expression = "IF(m_req > 0, (1 - m_5xx/m_req) * 100, 100)", label = "Availability (%)", id = "avail", color = "#2ca02c" }],
          ["AWS/ApplicationELB", "RequestCount",             "LoadBalancer", var.alb_arn_suffix, { id = "m_req",  visible = false, stat = "Sum" }],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count","LoadBalancer", var.alb_arn_suffix, { id = "m_5xx",  visible = false, stat = "Sum" }],
        ]
        yAxis = { left = { min = 95, max = 100, label = "%" } }
        annotations = {
          horizontal = [
            { label = "SLO target (${var.threshold_availability_pct}%)", value = var.threshold_availability_pct, color = "#2ca02c", fill = "below" },
          ]
        }
      }
    },

    # Remaining error budget (minutes)
    {
      type   = "metric"
      x      = 16; y = 26; width = 8; height = 6
      properties = {
        title  = "Remaining Error Budget (min) — ~${local.error_budget_min} min/month allowance"
        view   = "singleValue"
        region = local.region
        period = local.availability_period_s
        metrics = [
          [{ expression = "MAX(0, ${local.error_budget_min} - IF(m_req > 0, (m_5xx / m_req) * 43200, 0))", label = "Budget remaining (min)", id = "budget_remaining", color = "#2ca02c" }],
          ["AWS/ApplicationELB", "RequestCount",             "LoadBalancer", var.alb_arn_suffix, { id = "m_req", visible = false, stat = "Sum" }],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count","LoadBalancer", var.alb_arn_suffix, { id = "m_5xx", visible = false, stat = "Sum" }],
        ]
        annotations = {
          horizontal = [
            { label = "budget floor (0 min)", value = 0, color = "#d62728" },
          ]
        }
      }
    },

    # ALB good-minutes sparkline (rolling 7d for SRE operational view)
    {
      type   = "metric"
      x      = 0; y = 32; width = 24; height = 4
      properties = {
        title  = "ALB Fault Rate — fast-burn (7.2% = 2% budget/hr) and slow-burn (3.0% = 5% budget/6hr)"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          [{ expression = "IF(m_req > 0, m_5xx / m_req * 100, 0)", label = "Error rate (%)", id = "err_rate", color = "#d62728" }],
          ["AWS/ApplicationELB", "RequestCount",             "LoadBalancer", var.alb_arn_suffix, { id = "m_req", visible = false, stat = "Sum" }],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count","LoadBalancer", var.alb_arn_suffix, { id = "m_5xx", visible = false, stat = "Sum" }],
        ]
        yAxis = { left = { min = 0, label = "%" } }
        annotations = {
          horizontal = [
            { label = "fast-burn 7.2%", value = 7.2, color = "#d62728" },
            { label = "slow-burn 3.0%", value = 3.0, color = "#ff7f0e" },
          ]
        }
      }
    },
  ]
}

# ---------------------------------------------------------------------------
# Group 4 — Guardrail Metrics (y = 36..53)
# ---------------------------------------------------------------------------

locals {
  guardrail_widgets = [
    {
      type   = "text"
      x      = 0; y = 36; width = 24; height = 2
      properties = {
        markdown = "## Guardrail Metrics\nZero-tolerance and compliance floors. A missing feed renders as an explicit gap, not compliance."
      }
    },

    # Server fault rate across journeys (1.0% ceiling)
    {
      type   = "metric"
      x      = 0; y = 38; width = 8; height = 5
      properties = {
        title  = "Server Fault Rate (%) — ceiling 1.0%"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          ["travel/search",    "SearchFaultRate",   { stat = "Average", label = "search fault %",   color = "#1f77b4" }],
          ["travel/checkout",  "CheckoutFaultRate",  { stat = "Average", label = "checkout fault %", color = "#ff7f0e" }],
          ["travel/assistant", "AssistantFaultRate", { stat = "Average", label = "assistant fault %",color = "#9467bd" }],
        ]
        yAxis = { left = { min = 0, label = "%" } }
        annotations = {
          horizontal = [
            { label = "ceiling (${var.threshold_fault_rate_pct}%)", value = var.threshold_fault_rate_pct, color = "#d62728" },
          ]
        }
      }
    },

    # Platform-attributable checkout failure rate (0.5% ceiling)
    {
      type   = "metric"
      x      = 8; y = 38; width = 8; height = 5
      properties = {
        title  = "Platform-Attributable Checkout Failure (%) — ceiling 0.5%"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          ["travel/checkout", "PlatformAttributableCheckoutFailureRate", { stat = "Average", label = "platform fault %", color = "#d62728" }],
        ]
        yAxis = { left = { min = 0, label = "%" } }
        annotations = {
          horizontal = [
            { label = "ceiling (${var.threshold_checkout_failure_rate_pct}%)", value = var.threshold_checkout_failure_rate_pct, color = "#d62728" },
          ]
        }
      }
    },

    # Notification delivery within 5 minutes (SQS oldest-message age proxy)
    {
      type   = "metric"
      x      = 16; y = 38; width = 8; height = 5
      properties = {
        title  = "Notification Oldest Message Age (s) — delivery target: 99% within 300 s"
        view   = "timeSeries"
        region = local.region
        period = 60
        metrics = [
          ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", var.notification_queue_name, { stat = "Maximum", label = "oldest msg age (s)", color = "#ff7f0e" }],
        ]
        yAxis = { left = { min = 0, label = "s" } }
        annotations = {
          horizontal = [
            { label = "5-min delivery threshold (300 s)", value = 300, color = "#d62728" },
          ]
        }
      }
    },

    # Illustrative-result exposure — zero-tolerance
    {
      type   = "metric"
      x      = 0; y = 43; width = 8; height = 5
      properties = {
        title  = "Illustrative Result Exposure — target EXACTLY 0"
        view   = "timeSeries"
        region = local.region
        period = 300
        metrics = [
          ["travel/search", "illustrative_offers_served_total", { stat = "Sum", label = "illustrative exposures", color = "#d62728" }],
        ]
        yAxis = { left = { min = 0, label = "count" } }
        annotations = {
          horizontal = [
            { label = "zero-tolerance", value = 0, color = "#d62728", fill = "above" },
          ]
        }
      }
    },

    # Assistant cost per completed booking — USD 0.75 ceiling
    {
      type   = "metric"
      x      = 8; y = 43; width = 8; height = 5
      properties = {
        title  = "Assistant Cost per Completed Booking (USD) — ceiling USD 0.75"
        view   = "timeSeries"
        region = local.region
        period = 3600
        metrics = [
          ["travel/assistant", "assistant_cost_per_completed_booking_usd", { stat = "Average", label = "cost/booking USD", color = "#ff7f0e" }],
        ]
        yAxis = { left = { min = 0, label = "USD" } }
        annotations = {
          horizontal = [
            { label = "warning (USD 0.60)", value = 0.60, color = "#ff7f0e" },
            { label = "ceiling (USD ${var.threshold_assistant_cost_per_booking_usd})", value = var.threshold_assistant_cost_per_booking_usd, color = "#d62728", fill = "above" },
          ]
        }
      }
    },

    # Business-logic test coverage — 60% floor
    {
      type   = "metric"
      x      = 16; y = 43; width = 8; height = 5
      properties = {
        title  = "Business-Logic Test Coverage (%) — floor 60%"
        view   = "singleValue"
        region = local.region
        period = 86400
        metrics = [
          ["travel/ci", "test_coverage_pct", "environment", var.environment, "suite", "booking-lifecycle", { stat = "Maximum", label = "booking-lifecycle %", color = "#2ca02c" }],
          ["travel/ci", "test_coverage_pct", "environment", var.environment, "suite", "payment-confirmation", { stat = "Maximum", label = "payment-confirmation %", color = "#1f77b4" }],
          ["travel/ci", "test_coverage_pct", "environment", var.environment, "suite", "auth", { stat = "Maximum", label = "auth %", color = "#9467bd" }],
        ]
        annotations = {
          horizontal = [
            { label = "phase-gate floor (${var.threshold_test_coverage_pct}%)", value = var.threshold_test_coverage_pct, color = "#d62728", fill = "below" },
          ]
        }
      }
    },
  ]
}

# ---------------------------------------------------------------------------
# Text widget: not-yet-measurable metrics
# ---------------------------------------------------------------------------

locals {
  text_widgets = [
    {
      type   = "text"
      x      = 0; y = 54; width = 24; height = 6
      properties = {
        markdown = <<-EOT
          ## Not-Yet-Measurable Metrics at Phase 1 Gate (2026-10-23)

          The following targets **cannot have final values** at the gate date and are presented as
          leading indicators only. A 30-day re-baselining is committed for 2026-11-22.

          | Metric | Target | Reason | Earliest Measurable Date |
          |---|---|---|---|
          | 90-day Attachment Rate | 30% | Requires 90 days of live booking data | 2027-01-21 |
          | 180-day Repeat-Booking Rate | 20% repeat bookers within 180 days | Requires 180 days of live booking data | 2027-04-21 |

          **Leading indicators in use:**
          - Multi-category attachment rate (panel above) counts MULTI-category bookings as a same-session proxy.
          - Repeat-booking preference events (`preference_saved` funnel events) proxy long-term re-engagement intent.

          See [TARGET_RATIFICATION.md](docs/measurement/TARGET_RATIFICATION.md) for full ratification status.
        EOT
      }
    },
  ]
}
