variable "environment" {
  type        = string
  description = "Deployment environment (staging | production)."

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "vpc_id" {
  type        = string
  description = "VPC ID — the ElastiCache subnet group and security group are created here."
}

variable "private_app_subnet_ids" {
  type        = list(string)
  description = "Private application subnet IDs (one per AZ) for the ElastiCache replication group."
}

variable "service_sg_id" {
  type        = string
  description = "Security group ID for ECS service tasks — granted ingress on port 6379."
}

variable "kms_key_arn" {
  type        = string
  description = "ARN of the ElastiCache KMS CMK. Pass module.kms.key_arns[\"elasticache\"]."
}

variable "redis_auth_secret_arn" {
  type        = string
  description = "ARN of the Secrets Manager secret holding the Redis AUTH token. The secret value is the token string."
}

variable "node_type" {
  type        = string
  description = "ElastiCache node type."
  default     = "cache.r7g.large"
}

variable "num_cache_clusters" {
  type        = number
  description = "Number of replica nodes (including primary). Must be >= 2 for automatic failover."
  default     = 2

  validation {
    condition     = var.num_cache_clusters >= 2
    error_message = "num_cache_clusters must be at least 2 to enable automatic failover."
  }
}

variable "snapshot_retention_limit" {
  type        = number
  description = "Number of daily snapshots to retain (0 disables snapshots)."
  default     = 7
}

variable "alarm_sns_arn" {
  type        = string
  description = "SNS topic ARN for CloudWatch alarm notifications."
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all resources."
  default     = {}
}
