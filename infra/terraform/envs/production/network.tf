/**
 * Production network layer — instantiates the shared network module.
 *
 * Resource blocks in this file are byte-identical to envs/staging/network.tf
 * and envs/dev/main.tf. Only variable values (via terraform.tfvars) differ.
 * This satisfies the environment-isolation policy constraint: modules must be
 * identical across environments; environment-specific behaviour is expressed
 * exclusively through variables.
 */

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
output "vpc_cidr_output"         { value = module.network.vpc_cidr }
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
