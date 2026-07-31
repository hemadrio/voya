variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, production)."

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be one of: dev, staging, production."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID — used in globally-unique resource names."
}

variable "aws_region" {
  type        = string
  description = "Primary AWS region for workload resources (ALBs, S3 bucket)."
}

variable "vpc_id" {
  type        = string
  description = "VPC ID (from network module output)."
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "IDs of the public subnets — internet-facing ALB tier."
}

variable "private_app_subnet_ids" {
  type        = list(string)
  description = "IDs of the private application subnets — internal ALB tier."
}

variable "edge_alb_sg_id" {
  type        = string
  description = "Security group ID for the internet-facing ALB (from network module)."
}

variable "internal_alb_sg_id" {
  type        = string
  description = "Security group ID for the internal ALB (from network module)."
}

variable "domain_name" {
  type        = string
  description = "Primary domain name (e.g. travel.example.com). A wildcard certificate is issued for *.domain_name."
}

variable "route53_zone_id" {
  type        = string
  description = "Route 53 hosted zone ID for automated DNS validation of ACM certificates. Leave empty to skip DNS record creation (manual validation required)."
  default     = ""
}

variable "waf_log_retention_days" {
  type        = number
  description = "Number of days to retain WAF logs in S3. Must be ≥ 365 to satisfy audit retention."
  default     = 365

  validation {
    condition     = var.waf_log_retention_days >= 365
    error_message = "WAF log retention must be at least 365 days to satisfy audit evidence requirements."
  }
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to every resource created by this module."
  default     = {}
}
