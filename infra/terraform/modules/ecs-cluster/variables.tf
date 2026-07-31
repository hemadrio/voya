variable "environment" {
  type        = string
  description = "Deployment environment (dev | staging | production)."

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging, or production."
  }
}

variable "cluster_name" {
  type        = string
  description = "Name for the ECS cluster. Defaults to '<environment>-travel-platform'."
  default     = ""
}

variable "enable_fargate_spot" {
  type        = bool
  description = "Add FARGATE_SPOT as a capacity provider. Recommended for non-production to reduce costs."
  default     = false
}

variable "fargate_spot_weight" {
  type        = number
  description = "Capacity provider strategy weight for FARGATE_SPOT relative to FARGATE."
  default     = 1
}

variable "fargate_weight" {
  type        = number
  description = "Capacity provider strategy weight for FARGATE."
  default     = 1
}

variable "fargate_base" {
  type        = number
  description = "Minimum number of tasks always running on FARGATE (not SPOT)."
  default     = 1
}

variable "service_connect_namespace_name" {
  type        = string
  description = "Cloud Map HTTP namespace name for ECS Service Connect. E.g. 'travel.internal'."
  default     = ""
}

variable "vpc_id" {
  type        = string
  description = "VPC ID for the Cloud Map private DNS namespace (required when creating a DNS namespace)."
  default     = ""
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all resources."
  default     = {}
}
