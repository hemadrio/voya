# Staging environment — synthetic data only (BR-18)
# CIDR ranges are non-overlapping with dev (10.0.0.0/16) and production (10.2.0.0/16).

vpc_cidr           = "10.1.0.0/16"
availability_zones = ["a", "b", "c"]

public_subnet_cidrs = [
  "10.1.0.0/24",
  "10.1.1.0/24",
  "10.1.2.0/24",
]

private_app_subnet_cidrs = [
  "10.1.10.0/24",
  "10.1.11.0/24",
  "10.1.12.0/24",
]

private_data_subnet_cidrs = [
  "10.1.20.0/24",
  "10.1.21.0/24",
  "10.1.22.0/24",
]

# Single NAT gateway for cost control in staging.
nat_gateway_count       = 1
flow_log_retention_days = 90

tags = {
  Service            = "travel-platform"
  Environment        = "staging"
  CostCentre         = "platform-staging"
  Owner              = "platform-team"
  DataClassification = "Synthetic"
}

domain_name     = "staging.travel.example.com"
route53_zone_id = ""
