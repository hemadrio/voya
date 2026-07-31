# Elastic IPs for NAT gateways — one per NAT gateway
resource "aws_eip" "nat" {
  count  = var.nat_gateway_count
  domain = "vpc"

  tags = {
    Name        = "${var.environment}-nat-eip-${count.index}"
    Environment = var.environment
  }

  depends_on = [aws_internet_gateway.main]
}

# NAT gateways placed in public subnets.
# Production: one per AZ (nat_gateway_count = 3) for HA — a single-AZ NAT failure
# does not cut off egress from other AZs.
# Dev / staging: single NAT (nat_gateway_count = 1) to reduce cost.
# The modulo routing in route-tables.tf distributes private subnets across
# available NAT gateways, so the variable is the only difference between envs.
resource "aws_nat_gateway" "main" {
  count         = var.nat_gateway_count
  subnet_id     = aws_subnet.public[count.index].id
  allocation_id = aws_eip.nat[count.index].id

  tags = {
    Name        = "${var.environment}-nat-${count.index}"
    Environment = var.environment
  }

  depends_on = [aws_internet_gateway.main]
}
