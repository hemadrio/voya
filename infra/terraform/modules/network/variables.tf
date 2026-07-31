variable "environment" {
  type        = string
  description = "Deployment environment (dev | staging | production)."

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be 'dev', 'staging', or 'production'."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC (e.g. 10.0.0.0/16). Must not overlap with other environment VPCs."

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid CIDR block."
  }
}

variable "availability_zones" {
  type        = list(string)
  description = "AZ suffix list for this region (e.g. [\"a\", \"b\", \"c\"]). Length must equal the number of CIDRs in each subnet list."

  validation {
    condition     = length(var.availability_zones) >= 2 && length(var.availability_zones) <= 4
    error_message = "Between 2 and 4 availability zones are required."
  }
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for public subnets (internet-facing ALB tier). Length must match availability_zones."
}

variable "private_app_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for private application subnets (ECS task tier). Length must match availability_zones."
}

variable "private_data_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for private data subnets (RDS, ElastiCache). Length must match availability_zones."
}

variable "nat_gateway_count" {
  type        = number
  description = "Number of NAT gateways. Set to 1 for dev/staging (cost control) and length(availability_zones) for production (HA)."
  default     = 1

  validation {
    condition     = var.nat_gateway_count >= 1
    error_message = "At least one NAT gateway is required."
  }
}

variable "flow_log_retention_days" {
  type        = number
  description = "CloudWatch log retention period for VPC flow logs. Minimum 90 days for A09 compliance evidence."
  default     = 90

  validation {
    condition     = var.flow_log_retention_days >= 90
    error_message = "flow_log_retention_days must be >= 90 to satisfy the A09 audit-log retention requirement."
  }
}

variable "tags" {
  type = object({
    Service            = string
    Environment        = string
    CostCentre         = string
    Owner              = string
    DataClassification = string
  })
  description = "Mandatory cost-allocation and data-classification tag contract (BR-18). Applied via the aws provider default_tags block in each root stack."

  validation {
    condition     = can(regex("^[a-zA-Z0-9 _.:/=+@-]{1,256}$", var.tags.Service))
    error_message = "tags.Service contains characters disallowed by AWS resource tagging (allowed: alphanumeric, space, _ . : / = + @ -)."
  }

  validation {
    condition     = can(regex("^[a-zA-Z0-9 _.:/=+@-]{1,256}$", var.tags.CostCentre))
    error_message = "tags.CostCentre contains characters disallowed by AWS resource tagging."
  }

  validation {
    condition     = can(regex("^[a-zA-Z0-9 _.:/=+@-]{1,256}$", var.tags.Owner))
    error_message = "tags.Owner contains characters disallowed by AWS resource tagging."
  }

  validation {
    condition     = contains(["Public", "Internal", "Confidential", "Restricted", "Synthetic"], var.tags.DataClassification)
    error_message = "tags.DataClassification must be one of: Public, Internal, Confidential, Restricted, Synthetic."
  }
}
