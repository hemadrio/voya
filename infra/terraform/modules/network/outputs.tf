output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = aws_vpc.main.cidr_block
}

output "internet_gateway_id" {
  description = "Internet gateway ID."
  value       = aws_internet_gateway.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets (one per AZ)."
  value       = aws_subnet.public[*].id
}

output "private_app_subnet_ids" {
  description = "IDs of the private application subnets (ECS task tier, one per AZ)."
  value       = aws_subnet.private_app[*].id
}

output "private_data_subnet_ids" {
  description = "IDs of the private data subnets (RDS/ElastiCache tier, one per AZ)."
  value       = aws_subnet.private_data[*].id
}

output "nat_gateway_ids" {
  description = "IDs of the NAT gateways."
  value       = aws_nat_gateway.main[*].id
}

output "nat_gateway_public_ips" {
  description = "Public IPs of the NAT gateways. Use these for egress allow-listing at supplier APIs."
  value       = aws_eip.nat[*].public_ip
}

output "edge_alb_sg_id" {
  description = "Security group ID for the internet-facing ALB (edge-alb-sg)."
  value       = aws_security_group.edge_alb.id
}

output "gateway_sg_id" {
  description = "Security group ID for the API gateway service (gateway-sg)."
  value       = aws_security_group.gateway.id
}

output "internal_alb_sg_id" {
  description = "Security group ID for the internal ALB (internal-alb-sg)."
  value       = aws_security_group.internal_alb.id
}

output "service_sg_id" {
  description = "Security group ID for ECS service tasks (service-sg)."
  value       = aws_security_group.service.id
}

output "data_sg_id" {
  description = "Security group ID for the data tier — RDS and ElastiCache (data-sg)."
  value       = aws_security_group.data.id
}

output "vpc_flow_log_group_arn" {
  description = "ARN of the CloudWatch log group receiving VPC flow logs (A09 compliance evidence)."
  value       = aws_cloudwatch_log_group.vpc_flow_logs.arn
}
