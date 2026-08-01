/**
 * modules/slo/variables.tf — Input variables for the SLO alarm module.
 *
 * This module accepts a declarative SLO definition and emits:
 *   - Fast-burn alarm (high burn rate over short window — page severity)
 *   - Slow-burn alarm (lower burn rate over long window — ticket severity)
 *   - Hard-ceiling alarm (absolute threshold independent of burn rate)
 *   - No-data alarm (feed loss treated as breaching)
 *
 * All numeric thresholds are parameterised so the module can be instantiated
 * per environment without console-created resources.
 */

variable "slo_name" {
  description = "Short kebab-case identifier for this SLO (used in alarm names). Example: 'search-latency', 'availability'."
  type        = string
}

variable "slo_description" {
  description = "Human-readable description of the SLO for alarm descriptions."
  type        = string
}

variable "namespace" {
  description = "CloudWatch metric namespace. Example: 'travel/search'."
  type        = string
}

variable "metric_name" {
  description = "CloudWatch metric name. Example: 'SearchResponseP95'."
  type        = string
}

variable "slo_target" {
  description = "SLO target as a fraction in (0,1). Example: 0.995 for 99.5%."
  type        = number
  validation {
    condition     = var.slo_target > 0 && var.slo_target < 1
    error_message = "slo_target must be in the open interval (0, 1)."
  }
}

# ---------------------------------------------------------------------------
# Burn-rate alarm parameters
# ---------------------------------------------------------------------------

variable "fast_burn_rate" {
  description = "Burn-rate multiplier for the fast-burn alarm. Default: 14.4 (Google SRE recommended for 99.5% SLO)."
  type        = number
  default     = 14.4
}

variable "fast_burn_window_seconds" {
  description = "Measurement window for the fast-burn alarm in seconds. Default: 3600 (1 hour)."
  type        = number
  default     = 3600
}

variable "slow_burn_rate" {
  description = "Burn-rate multiplier for the slow-burn alarm. Default: 6 (Google SRE recommended)."
  type        = number
  default     = 6.0
}

variable "slow_burn_window_seconds" {
  description = "Measurement window for the slow-burn alarm in seconds. Default: 21600 (6 hours)."
  type        = number
  default     = 21600
}

variable "fast_burn_threshold_pct" {
  description = "Error-rate threshold (%) for the fast-burn alarm. Derived as fast_burn_rate × (1 - slo_target) × 100."
  type        = number
}

variable "slow_burn_threshold_pct" {
  description = "Error-rate threshold (%) for the slow-burn alarm. Derived as slow_burn_rate × (1 - slo_target) × 100."
  type        = number
}

# ---------------------------------------------------------------------------
# Hard-ceiling alarm (latency SLOs only)
# ---------------------------------------------------------------------------

variable "hard_ceiling_threshold" {
  description = "Hard-ceiling threshold for a simple absolute alarm (e.g., 5000 ms for search p95). Set to null to disable."
  type        = number
  default     = null
}

variable "hard_ceiling_statistic" {
  description = "CloudWatch extended statistic for the hard-ceiling alarm. Default: 'p95'."
  type        = string
  default     = "p95"
}

variable "hard_ceiling_comparison" {
  description = "CloudWatch comparison operator for the hard-ceiling alarm. Default: 'GreaterThanThreshold'."
  type        = string
  default     = "GreaterThanThreshold"
}

variable "hard_ceiling_period_seconds" {
  description = "Period in seconds for the hard-ceiling alarm. Default: 60."
  type        = number
  default     = 60
}

# ---------------------------------------------------------------------------
# No-data alarm (feed loss detection)
# ---------------------------------------------------------------------------

variable "enable_no_data_alarm" {
  description = "Whether to create a no-data alarm for this SLI feed. Default: true. Disable only for metrics that legitimately have no traffic (not recommended)."
  type        = bool
  default     = true
}

variable "no_data_period_seconds" {
  description = "Period in seconds after which absence of metric data triggers the no-data alarm. Default: 300 (5 minutes)."
  type        = number
  default     = 300
}

# ---------------------------------------------------------------------------
# ALB dimensions (for availability/fault-rate SLOs sourced from ALB)
# ---------------------------------------------------------------------------

variable "alb_arn_suffix" {
  description = "ALB ARN suffix for metric dimensions. Empty string disables ALB-dimension filtering."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# SNS topics
# ---------------------------------------------------------------------------

variable "page_alarm_arn" {
  description = "ARN of the SNS topic to notify for CRITICAL (paging) alarms."
  type        = string
}

variable "ticket_alarm_arn" {
  description = "ARN of the SNS topic to notify for HIGH (ticket-creating) alarms."
  type        = string
}

# ---------------------------------------------------------------------------
# Tagging / environment
# ---------------------------------------------------------------------------

variable "environment" {
  description = "Deployment environment (e.g., 'staging', 'production')."
  type        = string
}

variable "runbook_base_url" {
  description = "Base URL for runbook links appended to alarm descriptions."
  type        = string
  default     = "https://github.com/your-org/travel-platform/blob/main/docs/runbooks"
}
