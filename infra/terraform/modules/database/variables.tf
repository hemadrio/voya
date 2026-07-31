variable "environment" {
  type        = string
  description = "Deployment environment (staging | production)."

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID — used in cross-region backup replication ARNs."
}

variable "aws_region" {
  type        = string
  description = "Primary workload region."
}

variable "secondary_region" {
  type        = string
  description = "Secondary AWS region for cross-region automated backup replication."
  default     = "us-east-1"
}

variable "vpc_id" {
  type        = string
  description = "VPC ID — the DB subnet group and security group are created here."
}

variable "private_data_subnet_ids" {
  type        = list(string)
  description = "IDs of the private data subnets (one per AZ) for the DB subnet group."
}

variable "service_sg_id" {
  type        = string
  description = "Security group ID for ECS service tasks. Ingress from this SG to the proxy SG is what services use — the RDS SG only accepts the proxy SG."
}

variable "kms_key_arn" {
  type        = string
  description = "ARN of the RDS KMS CMK. Pass module.kms.key_arns[\"rds\"]."
}

variable "master_username" {
  type        = string
  description = "Master database username. Avoid 'postgres' or 'admin' (reserved)."
  default     = "travel_admin"
}

variable "db_secret_arn" {
  type        = string
  description = "Reserved for future use. The module generates master credentials via manage_master_user_password; the resulting secret ARN is exposed as master_user_secret_arn output for the rds-proxy module."
  default     = ""
}

variable "instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.r6g.large"
}

variable "allocated_storage_gb" {
  type        = number
  description = "Initial allocated storage in GB."
  default     = 100

  validation {
    condition     = var.allocated_storage_gb >= 20 && var.allocated_storage_gb <= 65536
    error_message = "allocated_storage_gb must be between 20 and 65536."
  }
}

variable "max_allocated_storage_gb" {
  type        = number
  description = "Maximum storage in GB for autoscaling."
  default     = 500
}

variable "backup_retention_days" {
  type        = number
  description = "Automated backup retention in days. 35 provides ~5 weeks of PITR. Must be >= 1 for cross-region replication."
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 7 and 35."
  }
}

variable "deletion_protection" {
  type        = bool
  description = "Enable RDS deletion protection. Must be true in production; requires a two-step disable before terraform destroy."
  default     = true
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
