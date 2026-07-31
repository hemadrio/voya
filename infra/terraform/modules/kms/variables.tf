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
  description = "AWS account ID — used in key policies to grant the account root full key management."
}

variable "allowed_principal_arns" {
  type        = map(list(string))
  description = <<-EOT
    Map of store name to list of IAM role/user ARNs that are allowed to
    call kms:Decrypt and kms:GenerateDataKey* on that store's CMK.
    Keys must be one of: rds, elasticache, s3, sqs, secretsmanager.
    Only the roles that NEED decrypt access for a given store should be listed.
  EOT

  default = {
    rds            = []
    elasticache    = []
    s3             = []
    sqs            = []
    secretsmanager = []
  }
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all KMS key resources."
  default     = {}
}
