# budgets/main.tf — WO-089: Cost allocation budgets
#
# Creates:
#   1. A total monthly environment budget filtered to the Environment tag value.
#   2. Per-cost-line budgets for each entry in var.service_line_budgets, filtered
#      by AWS service name AND the environment Environment tag.
#   3. (Optional) A separate budget for the load-test environment tag value so
#      load-testing spend does not mask production regressions.
#
# All budgets notify var.notification_sns_topic_arn at:
#   - 80% FORECASTED — early warning ahead of month-end
#   - 100% ACTUAL    — threshold breach
#
# Budget filter values use the AWS Budgets "TagKeyValue" format: "user:Key$value".
# The format() function is used to avoid HCL template-vs-dollar-sign ambiguity.

locals {
  env_tag_filter = format("user:Environment$%s", var.environment)
}

# ── 1. Total monthly environment budget ───────────────────────────────────────

resource "aws_budgets_budget" "total" {
  name         = format("%s-total-monthly", var.environment)
  budget_type  = "COST"
  limit_amount = tostring(var.total_monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [local.env_tag_filter]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [var.notification_sns_topic_arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [var.notification_sns_topic_arn]
  }
}

# ── 2. Per-cost-line budgets ──────────────────────────────────────────────────

resource "aws_budgets_budget" "service_line" {
  for_each = var.service_line_budgets

  name         = format("%s-%s-monthly", var.environment, each.key)
  budget_type  = "COST"
  limit_amount = tostring(each.value.limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Filter to the specific AWS service(s) for this cost line
  cost_filter {
    name   = "Service"
    values = each.value.aws_service_names
  }

  # AND filter to this environment's cost centre via the Environment tag
  cost_filter {
    name   = "TagKeyValue"
    values = [local.env_tag_filter]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [var.notification_sns_topic_arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [var.notification_sns_topic_arn]
  }
}

# ── 3. Load-test environment budget (separate cost centre) ────────────────────

resource "aws_budgets_budget" "load_test" {
  count = var.enable_load_test_budget ? 1 : 0

  name         = "load-test-total-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.load_test_monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Filter to the load-test Environment tag value — separate from production.
  # Keeps Speedscale replay spend from masking genuine production cost regressions.
  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Environment$load-test"]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [var.notification_sns_topic_arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [var.notification_sns_topic_arn]
  }
}
