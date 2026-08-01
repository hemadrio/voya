variable "environment" {
  type        = string
  description = "Deployment environment (dev | staging | production)"

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be 'dev', 'staging', or 'production'."
  }
}

variable "name_prefix" {
  type        = string
  description = "Prefix for ECR repository names (e.g. 'travel')."
}

variable "service_names" {
  type        = list(string)
  description = "List of service names — one ECR repository is created per entry."
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN used to encrypt ECR images at rest."
}

variable "ci_role_arn" {
  type        = string
  description = "IAM role ARN for the CI pipeline — granted push access."
}

variable "task_execution_role_arns" {
  type        = list(string)
  description = "List of ECS task execution role ARNs — granted pull access."
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all ECR resources."
  default     = {}
}
