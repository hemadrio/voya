variable "environment" {
  type        = string
  description = "Deployment environment name (staging | production)"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "service_name" {
  type        = string
  description = "Short service name, e.g. 'auth-service'. Used in resource names and tags."
}

variable "container_image" {
  type        = string
  description = "Fully-qualified container image URI, e.g. 123456789012.dkr.ecr.eu-west-1.amazonaws.com/auth-service:sha-abc123"
}

variable "cpu" {
  type        = number
  description = "Task CPU units (256, 512, 1024, 2048, 4096)."
  default     = 512
}

variable "memory" {
  type        = number
  description = "Task memory in MiB."
  default     = 1024
}

variable "port" {
  type        = number
  description = "Container port the service listens on."
  default     = 3000
}

variable "environment_vars" {
  type        = map(string)
  description = <<-EOT
    Non-secret environment variables injected into the container.
    Must NOT contain any key matching the pattern SECRET|KEY|TOKEN|PASSWORD
    (case-insensitive). Secret values must be declared in secret_refs instead.
  EOT
  default     = {}

  validation {
    condition = !anytrue([
      for k in keys(var.environment_vars) :
      can(regex("(?i)(SECRET|KEY|TOKEN|PASSWORD)", k))
    ])
    error_message = "environment_vars must not contain keys matching SECRET, KEY, TOKEN, or PASSWORD. Move those values to secret_refs."
  }
}

variable "secret_refs" {
  type        = map(string)
  description = <<-EOT
    Map of environment variable name to Secrets Manager secret ARN (valueFrom).
    These are injected into the container via the ECS secrets block at task start.
    The value must be a full secret ARN (arn:aws:secretsmanager:...).
  EOT
  default     = {}
}

variable "kms_key_arns" {
  type        = list(string)
  description = "KMS key ARNs the task execution role must be able to call kms:Decrypt on."
  default     = []
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used to scope IAM policy ARNs."
}

variable "aws_region" {
  type        = string
  description = "AWS region, e.g. eu-west-1."
}

variable "log_group_name" {
  type        = string
  description = "CloudWatch Logs log group name for the service."
}

variable "ecs_cluster_arn" {
  type        = string
  description = "ARN of the ECS cluster to register the service in."
}

variable "subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for the ECS service network configuration."
}

variable "security_group_ids" {
  type        = list(string)
  description = "Security group IDs attached to the ECS service."
}

variable "desired_count" {
  type        = number
  description = "Desired number of running tasks."
  default     = 2
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all resources in this module."
  default     = {}
}
