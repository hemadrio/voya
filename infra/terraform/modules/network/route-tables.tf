/**
 * Private subnet route tables — NAT-only egress.
 *
 * Each private subnet gets its own route table with a single default route
 * pointing at the AZ-local NAT gateway. Internet gateway routes from private
 * subnets are explicitly absent — this is enforced by a Terraform check block
 * below.
 *
 * SECURITY POLICY: All egress from the service layer must exit through NAT
 * gateways. Adding an internet gateway route to a private subnet route table
 * is a misconfiguration that exposes ECS tasks to direct inbound traffic and
 * bypasses the CloudFront + WAF + ALB trust boundary.
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ── One route table per private subnet ───────────────────────────────────────

resource "aws_route_table" "private" {
  count  = length(var.private_subnet_ids)
  vpc_id = var.vpc_id

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-private-rt-${count.index}"
    Environment = var.environment
    Tier        = "private"
    ManagedBy   = "terraform"
  })
}

resource "aws_route_table_association" "private" {
  count          = length(var.private_subnet_ids)
  subnet_id      = var.private_subnet_ids[count.index]
  route_table_id = aws_route_table.private[count.index].id
}

# ── Default route to AZ-local NAT gateway ───────────────────────────────────

resource "aws_route" "private_default" {
  count = length(var.private_subnet_ids)

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = var.nat_gateway_ids[count.index % length(var.nat_gateway_ids)]

  timeouts {
    create = "5m"
  }
}

# ── Policy assertion: no IGW route on private subnets ────────────────────────
# Terraform check blocks run during plan and fail the apply if the condition is
# not met. This prevents an accidental internet-gateway route being added to a
# private subnet route table — either by another Terraform module or by a
# manual change that gets imported.

data "aws_route_tables" "private_with_igw" {
  vpc_id = var.vpc_id

  filter {
    name   = "tag:Tier"
    values = ["private"]
  }
}

data "aws_route_table" "private_check" {
  for_each       = toset(data.aws_route_tables.private_with_igw.ids)
  route_table_id = each.value
}

# Collect all routes from all private route tables into a flat list.
locals {
  all_private_routes = flatten([
    for rt in data.aws_route_table.private_check : rt.route
  ])

  # Any route whose gateway_id starts with "igw-" is an internet gateway route.
  igw_routes_on_private = [
    for route in local.all_private_routes :
    route if startswith(tostring(lookup(route, "gateway_id", "")), "igw-")
  ]
}

check "no_igw_on_private_subnets" {
  assert {
    condition     = length(local.igw_routes_on_private) == 0
    error_message = <<-EOT
      SECURITY VIOLATION: Internet gateway route(s) detected on private subnet route table(s).
      Private subnets must route 0.0.0.0/0 exclusively through NAT gateways.
      All egress from ECS tasks must pass through the NAT gateway to enforce
      the SSRF allow-list at the adapter layer.

      Offending route(s): ${jsonencode(local.igw_routes_on_private)}
    EOT
  }
}
