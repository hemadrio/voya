/**
 * Development environment root module.
 *
 * Instantiates the network module for the development VPC.
 * Single NAT gateway for cost control (nat_gateway_count = 1).
 * All data subnets tagged DataClassification=Synthetic — production
 * data must never be restored here.
 *
 * Manual approval gate: not required for development; engineers may apply
 * directly to dev from feature branches.
 */

locals {
  environment = "dev"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

module "network" {
  source = "../../modules/network"

  environment               = local.environment
  vpc_cidr                  = var.vpc_cidr
  availability_zones        = var.availability_zones
  public_subnet_cidrs       = var.public_subnet_cidrs
  private_app_subnet_cidrs  = var.private_app_subnet_cidrs
  private_data_subnet_cidrs = var.private_data_subnet_cidrs
  nat_gateway_count         = var.nat_gateway_count
  flow_log_retention_days   = var.flow_log_retention_days
  tags                      = var.tags
}

output "vpc_id"                  { value = module.network.vpc_id }
output "vpc_cidr"                { value = module.network.vpc_cidr }
output "public_subnet_ids"       { value = module.network.public_subnet_ids }
output "private_app_subnet_ids"  { value = module.network.private_app_subnet_ids }
output "private_data_subnet_ids" { value = module.network.private_data_subnet_ids }
output "nat_gateway_ids"         { value = module.network.nat_gateway_ids }
output "nat_gateway_public_ips"  { value = module.network.nat_gateway_public_ips }
output "edge_alb_sg_id"          { value = module.network.edge_alb_sg_id }
output "gateway_sg_id"           { value = module.network.gateway_sg_id }
output "internal_alb_sg_id"      { value = module.network.internal_alb_sg_id }
output "service_sg_id"           { value = module.network.service_sg_id }
output "data_sg_id"              { value = module.network.data_sg_id }
output "vpc_flow_log_group_arn"  { value = module.network.vpc_flow_log_group_arn }
