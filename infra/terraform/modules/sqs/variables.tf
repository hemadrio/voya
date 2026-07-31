variable "environment" {
  type        = string
  description = "Deployment environment (staging | production)."

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "kms_key_arn" {
  type        = string
  description = "ARN of the KMS CMK used to encrypt SQS queue messages. Pass module.kms.key_arns[\"sqs\"]."

  validation {
    condition     = can(regex("^arn:aws:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a valid AWS KMS key ARN."
  }
}

variable "alarm_sns_arn" {
  type        = string
  description = "ARN of the SNS topic that receives CloudWatch alarm notifications. Pass the ARN from monitoring.tf."

  validation {
    condition     = can(regex("^arn:aws:sns:", var.alarm_sns_arn))
    error_message = "alarm_sns_arn must be a valid AWS SNS topic ARN."
  }
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to every resource in this module."
  default     = {}
}

variable "max_receive_count" {
  type        = number
  description = "Number of delivery attempts before a message is moved to the DLQ."
  default     = 5

  validation {
    condition     = var.max_receive_count >= 1 && var.max_receive_count <= 1000
    error_message = "max_receive_count must be between 1 and 1000."
  }
}
