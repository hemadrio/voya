# Network Module

Provisions a three-tier VPC across three availability zones for the travel platform.

## Architecture

```
Internet
    │
  [edge-alb-sg]  ← public subnets (ALB)
    │
  [gateway-sg]   ─── private-app subnets (ECS gateway task)
    │
  [internal-alb-sg] ← private-app subnets
    │
  [service-sg]   ─── private-app subnets (ECS service tasks)
    │
  [data-sg]      ─── private-data subnets (RDS, ElastiCache)
```

Private subnets have **no direct internet access**. All egress routes through NAT gateways (enforced by a Terraform `check` block that fails on any IGW route in a private route table).

## Subnet CIDR layout (per environment)

| Environment | VPC CIDR      | Public          | Private App     | Private Data    |
|-------------|---------------|-----------------|-----------------|-----------------|
| dev         | 10.0.0.0/16   | 10.0.{0-2}.0/24 | 10.0.{10-12}.0/24 | 10.0.{20-22}.0/24 |
| staging     | 10.1.0.0/16   | 10.1.{0-2}.0/24 | 10.1.{10-12}.0/24 | 10.1.{20-22}.0/24 |
| production  | 10.2.0.0/16   | 10.2.{0-2}.0/24 | 10.2.{10-12}.0/24 | 10.2.{20-22}.0/24 |

CIDRs are non-overlapping for future peering or Transit Gateway.

## Variables

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `environment` | string | required | dev / staging / production |
| `vpc_cidr` | string | required | VPC CIDR block |
| `availability_zones` | list(string) | required | AZ suffixes, e.g. ["a","b","c"] |
| `public_subnet_cidrs` | list(string) | required | One per AZ |
| `private_app_subnet_cidrs` | list(string) | required | One per AZ |
| `private_data_subnet_cidrs` | list(string) | required | One per AZ |
| `nat_gateway_count` | number | 1 | 1 for dev/staging, 3 for prod |
| `flow_log_retention_days` | number | 90 | Minimum 90 (A09) |
| `tags` | object | required | Service, Environment, CostCentre, Owner, DataClassification |

## Outputs

All security group IDs, subnet ID lists, NAT gateway IDs, and the flow log ARN are exported for consumption by downstream modules (RDS, ECS, ALB).

## Security policies

- `data-sg` accepts 5432/6379 from `service-sg` only (no CIDR ingress).
- `edge-alb-sg` is the only SG that accepts public internet traffic (443/80).
- Private route tables contain no internet gateway route (enforced by `check "no_igw_on_private_subnets"`).
- Non-production `private_data` subnets are tagged `DataClassification=Synthetic` (BR-18).
- VPC flow logs are retained for 90+ days (A09 evidence).

## Bootstrap

Before running `terraform init` on an environment root stack, provision the S3 + DynamoDB state backend:

```bash
cd infra/terraform/bootstrap
terraform init
terraform apply -var="environment=dev"
# Repeat for staging and production
```

## Running tests

```bash
cd infra/terraform/modules/network/tests
# Plan-only (no AWS apply, no resources created)
go test -v -run TestNetworkModuleDev -timeout 10m
go test -v -run TestNetworkModuleProduction -timeout 10m

# CI version check
./scripts/check-terraform-version.sh
```
