variable "environment" {
  type        = string
  description = "Deployment environment name (staging | production)"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID — used in IAM resource ARNs."
}

variable "aws_region" {
  type        = string
  description = "AWS region, e.g. eu-west-1."
}

variable "vpc_id" {
  type        = string
  description = "VPC ID the proxy endpoint and security group are created in."
}

variable "subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs the proxy is placed in (should match the RDS subnets)."
}

variable "rds_instance_identifier" {
  type        = string
  description = "RDS DB instance identifier the proxy forwards connections to."
}

variable "rds_security_group_id" {
  type        = string
  description = "Security group ID attached to the RDS instance — proxy SG is granted ingress on 5432."
}

variable "db_secret_arn" {
  type        = string
  description = "ARN of the Secrets Manager secret holding the RDS master credentials (username/password JSON). Used by the proxy auth block."
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN used to encrypt the proxy endpoint connection metadata."
}

# ── Connection budget ─────────────────────────────────────────────────────────

variable "max_connections_percent" {
  type        = number
  description = <<-EOT
    Percentage of the RDS instance max_connections the proxy may open as
    server-side (pinned) connections.  Computed from the connection budget
    in connection-budget.md.  Must leave headroom for operational tasks.
  EOT
  default     = 20

  validation {
    condition     = var.max_connections_percent >= 5 && var.max_connections_percent <= 90
    error_message = "max_connections_percent must be between 5 and 90."
  }
}

variable "max_idle_connections_percent" {
  type        = number
  description = "Maximum idle server connections kept open as a percentage of max_connections_percent."
  default     = 1
}

variable "connection_borrow_timeout" {
  type        = number
  description = "Seconds the proxy waits when all connections are in use before returning an error to the client."
  default     = 120
}

# ── Per-service DB users ───────────────────────────────────────────────────────

variable "db_service_users" {
  type        = map(string)
  description = <<-EOT
    Map of logical service name to the PostgreSQL username that service
    authenticates as through the proxy.  Used to construct per-service
    rds-db:connect IAM resource ARNs.
    Example: { "booking-service" = "booking_svc" }
  EOT
}

variable "migration_db_user" {
  type        = string
  description = "PostgreSQL username used by the one-off ECS migration task."
  default     = "migration_task"
}

variable "purge_worker_db_user" {
  type        = string
  description = "PostgreSQL username used by the scheduled purge worker."
  default     = "purge_worker"
}

# ── CloudWatch alarms ─────────────────────────────────────────────────────────

variable "alarm_sns_arn" {
  type        = string
  description = "SNS topic ARN to receive CloudWatch alarm notifications."
}

variable "borrow_latency_threshold_ms" {
  type        = number
  description = "ConnectionBorrowLatency alarm threshold in milliseconds."
  default     = 1000
}

variable "connection_utilisation_threshold_pct" {
  type        = number
  description = "DatabaseConnections alarm threshold as a percentage of the computed connection budget."
  default     = 80
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all resources."
  default     = {}
}
