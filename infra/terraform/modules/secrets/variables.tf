variable "environment" {
  type        = string
  description = "Deployment environment name (staging | production)"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "kms_key_arn" {
  type        = string
  description = "ARN of the KMS CMK used to encrypt all secrets in this module (the secretsmanager store key)."
}

variable "rotation_lambda_arn" {
  type        = string
  description = "ARN of the Lambda function used for automatic secret rotation. Leave empty to skip rotation resource creation."
  default     = ""
}

variable "rotation_days" {
  type        = number
  description = "Automatic rotation interval in days. Must not exceed 90 per security policy."
  default     = 90

  validation {
    condition     = var.rotation_days >= 1 && var.rotation_days <= 90
    error_message = "rotation_days must be between 1 and 90 (inclusive)."
  }
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all Secrets Manager resources."
  default     = {}
}
