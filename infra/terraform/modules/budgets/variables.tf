variable "environment" {
  type        = string
  description = "Environment name (dev / staging / production / load-test)."

  validation {
    condition     = contains(["dev", "staging", "production", "load-test"], var.environment)
    error_message = "environment must be one of: dev, staging, production, load-test."
  }
}

variable "total_monthly_limit_usd" {
  type        = number
  description = "Total monthly budget threshold in USD for this environment."

  validation {
    condition     = var.total_monthly_limit_usd > 0
    error_message = "total_monthly_limit_usd must be positive."
  }
}

variable "notification_sns_topic_arn" {
  type        = string
  description = "SNS topic ARN that receives budget alert notifications (80% forecast + 100% actual)."

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:sns:", var.notification_sns_topic_arn))
    error_message = "notification_sns_topic_arn must be a valid SNS topic ARN."
  }
}

variable "service_line_budgets" {
  type = map(object({
    limit_usd         = number
    aws_service_names = list(string)
  }))
  description = <<-EOT
    Per-cost-line budget configurations keyed by a friendly name (e.g. "fargate", "rds").
    Each entry creates an aws_budgets_budget resource filtered to the specified AWS service names
    and to this environment's Environment tag.
    aws_service_names must match the exact AWS service names used in Cost Explorer dimensions
    (e.g. "Amazon Elastic Container Service", "Amazon Relational Database Service").
  EOT
  default     = {}
}

variable "enable_load_test_budget" {
  type        = bool
  description = "Create a separate monthly budget for the load-test Environment tag value."
  default     = false
}

variable "load_test_monthly_limit_usd" {
  type        = number
  description = "Monthly budget limit in USD for the load-testing environment. Used only when enable_load_test_budget is true."
  default     = 500
}
