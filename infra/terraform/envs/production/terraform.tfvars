# Production environment
# CIDR ranges are non-overlapping with dev (10.0.0.0/16) and staging (10.1.0.0/16).
# DataClassification=Confidential — no synthetic data policy applies; data-sg
# subnets do NOT receive the Synthetic tag override (managed by the module).

vpc_cidr           = "10.2.0.0/16"
availability_zones = ["a", "b", "c"]

public_subnet_cidrs = [
  "10.2.0.0/24",
  "10.2.1.0/24",
  "10.2.2.0/24",
]

private_app_subnet_cidrs = [
  "10.2.10.0/24",
  "10.2.11.0/24",
  "10.2.12.0/24",
]

private_data_subnet_cidrs = [
  "10.2.20.0/24",
  "10.2.21.0/24",
  "10.2.22.0/24",
]

# One NAT gateway per AZ for high availability in production.
nat_gateway_count       = 3
flow_log_retention_days = 90

tags = {
  Service            = "travel-platform"
  Environment        = "production"
  CostCentre         = "platform-prod"
  Owner              = "platform-team"
  DataClassification = "Confidential"
}

# Domain for ACM certificates (edge module). Override in environment-specific CI/CD.
# Set route53_zone_id to enable automated DNS validation via Route 53.
domain_name     = "travel.example.com"
route53_zone_id = ""
