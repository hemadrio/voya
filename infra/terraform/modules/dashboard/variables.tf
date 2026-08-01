/**
 * modules/dashboard/variables.tf — Input variables for the operational metrics dashboard.
 *
 * The dashboard is parameterised per environment so the same module can be
 * applied to staging and production without console edits (SOC 2 requirement).
 */

variable "environment" {
  description = "Deployment environment (e.g., 'staging', 'production')."
  type        = string
}

variable "aws_region" {
  description = "AWS region in which the dashboard is created."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account ID (used to build alarm ARNs)."
  type        = string
}

# ---------------------------------------------------------------------------
# ALB dimensions (used by availability and latency panels)
# ---------------------------------------------------------------------------

variable "alb_arn_suffix" {
  description = "ALB ARN suffix returned by aws_lb.arn_suffix. Used for AWS/ApplicationELB metrics."
  type        = string
}

variable "alb_target_group_arn_suffix" {
  description = "Target group ARN suffix returned by aws_lb_target_group.arn_suffix."
  type        = string
}

# ---------------------------------------------------------------------------
# SQS dimension (notification delivery guardrail)
# ---------------------------------------------------------------------------

variable "notification_queue_name" {
  description = "Name of the SQS notification queue (used for ApproximateAgeOfOldestMessage)."
  type        = string
}

# ---------------------------------------------------------------------------
# Thresholds — must match committed architecture numbers
# ---------------------------------------------------------------------------

variable "threshold_search_cache_p95_ms" {
  description = "Search cache-hit latency annotation. Committed: 180 ms."
  type        = number
  default     = 180
}

variable "threshold_search_p95_warning_ms" {
  description = "Search overall p95 warning annotation. Committed: 3000 ms."
  type        = number
  default     = 3000
}

variable "threshold_search_p95_hard_ms" {
  description = "Search overall p95 hard-alert annotation. Committed: 5000 ms."
  type        = number
  default     = 5000
}

variable "threshold_checkout_p95_ms" {
  description = "Checkout acknowledgement p95 annotation. Committed: 5000 ms."
  type        = number
  default     = 5000
}

variable "threshold_assistant_first_token_p95_ms" {
  description = "Assistant first-token p95 annotation. Committed: 2000 ms."
  type        = number
  default     = 2000
}

variable "threshold_availability_pct" {
  description = "Availability SLO target annotation. Committed: 99.5%."
  type        = number
  default     = 99.5
}

variable "error_budget_minutes_per_month" {
  description = "Monthly error budget in minutes at the 99.5% SLO (30-day month × 0.5%). Committed: ~219."
  type        = number
  default     = 219
}

variable "threshold_fault_rate_pct" {
  description = "Server fault rate ceiling annotation. Committed: 1.0%."
  type        = number
  default     = 1.0
}

variable "threshold_checkout_failure_rate_pct" {
  description = "Platform-attributable checkout failure rate ceiling. Committed: 0.5%."
  type        = number
  default     = 0.5
}

variable "threshold_notification_delivery_pct" {
  description = "Notification delivery-within-5-minutes target. Committed: 99%."
  type        = number
  default     = 99
}

variable "threshold_assistant_cost_per_booking_usd" {
  description = "Assistant cost per completed booking ceiling. Committed: USD 0.75."
  type        = number
  default     = 0.75
}

variable "threshold_test_coverage_pct" {
  description = "Business-logic test coverage floor. Committed: 60%."
  type        = number
  default     = 60
}
