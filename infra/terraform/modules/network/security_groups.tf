/**
 * Security group matrix — named, purpose-scoped resources.
 *
 * Trust chain: internet → edge-alb-sg → gateway-sg → internal-alb-sg → service-sg → data-sg
 *
 * Every non-edge ingress rule references a source security group ID (never a
 * CIDR block), enforcing the single-governed-entry-point constraint. The only
 * CIDR 0.0.0.0/0 ingress is on ports 80 and 443 of the public-facing ALB.
 */

# edge-alb-sg — internet-facing ALB: the only resource that accepts public traffic
resource "aws_security_group" "edge_alb" {
  name        = "${var.environment}-edge-alb-sg"
  description = "Internet-facing ALB: accepts 80/443 from the public internet only."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS from internet"
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP from internet (redirect to HTTPS)"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name        = "${var.environment}-edge-alb-sg"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

# gateway-sg — API gateway service: accepts only from edge-alb-sg
resource "aws_security_group" "gateway" {
  name        = "${var.environment}-gateway-sg"
  description = "API gateway ECS task: accepts traffic from edge-alb-sg only."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.edge_alb.id]
    description     = "Application traffic from edge ALB"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound (NAT enforces destination allow-list)"
  }

  tags = {
    Name        = "${var.environment}-gateway-sg"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

# internal-alb-sg — internal load balancer: accepts only from gateway-sg
resource "aws_security_group" "internal_alb" {
  name        = "${var.environment}-internal-alb-sg"
  description = "Internal ALB: accepts traffic from gateway-sg only."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.gateway.id]
    description     = "HTTPS from gateway service"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = {
    Name        = "${var.environment}-internal-alb-sg"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

# service-sg — ECS service tasks: accepts only from internal-alb-sg
resource "aws_security_group" "service" {
  name        = "${var.environment}-service-sg"
  description = "ECS service tasks: accepts traffic from internal-alb-sg only."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.internal_alb.id]
    description     = "Application traffic from internal ALB"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound (NAT enforces destination allow-list)"
  }

  tags = {
    Name        = "${var.environment}-service-sg"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

# data-sg — data tier (RDS, ElastiCache): accepts 5432/6379 only from service-sg
resource "aws_security_group" "data" {
  name        = "${var.environment}-data-sg"
  description = "Data tier (RDS, ElastiCache): accepts 5432/6379 from service-sg only."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
    description     = "PostgreSQL from service tier"
  }

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
    description     = "Redis from service tier"
  }

  tags = {
    Name        = "${var.environment}-data-sg"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}
