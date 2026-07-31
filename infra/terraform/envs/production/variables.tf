variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC."
}

variable "availability_zones" {
  type        = list(string)
  description = "AZ suffix list (e.g. [\"a\", \"b\", \"c\"])."
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for public subnets."
}

variable "private_app_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for private application subnets."
}

variable "private_data_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for private data subnets."
}

variable "nat_gateway_count" {
  type        = number
  description = "Number of NAT gateways (1 for staging, 3 for production)."
  default     = 3
}

variable "flow_log_retention_days" {
  type        = number
  description = "CloudWatch log retention for VPC flow logs (days)."
  default     = 90
}

variable "tags" {
  type = object({
    Service            = string
    Environment        = string
    CostCentre         = string
    Owner              = string
    DataClassification = string
  })
  description = "Mandatory tag contract applied via provider default_tags."
}
