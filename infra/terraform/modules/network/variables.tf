variable "environment" {
  type        = string
  description = "Deployment environment name (staging | production)"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "vpc_id" {
  type        = string
  description = "VPC ID the route tables belong to."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "IDs of the private subnets that must route to NAT gateways only."
}

variable "nat_gateway_ids" {
  type        = list(string)
  description = "NAT gateway IDs — one per AZ. Private subnets route 0.0.0.0/0 here."
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all networking resources."
  default     = {}
}
