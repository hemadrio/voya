/**
 * Development environment root module.
 *
 * Instantiates the full service stack for the development VPC.
 * Single NAT gateway for cost control (nat_gateway_count = 1).
 * All data subnets tagged DataClassification=Synthetic — production
 * data must never be restored here.
 *
 * Manual approval gate: not required for development; engineers may apply
 * directly to dev from feature branches.
 */

locals {
  environment    = "dev"
  aws_account_id = data.aws_caller_identity.current.account_id
  aws_region     = data.aws_region.current.name

  common_tags = {
    Project     = "travel-platform"
    Environment = local.environment
    ManagedBy   = "terraform"
  }

  service_secret_map = {
    "auth-service"         = ["jwt-signing-key", "google-oauth-client-id", "google-oauth-client-secret"]
    "booking-service"      = ["db-url", "redis-auth-token"]
    "search-service"       = ["amadeus-client-id", "amadeus-client-secret", "rapidapi-key"]
    "payment-service"      = ["stripe-secret-key", "stripe-webhook-secret"]
    "ai-service"           = ["anthropic-key"]
    "user-service"         = ["db-url"]
    "itinerary-service"    = ["db-url"]
    "reporting-service"    = ["db-url"]
    "notification-service" = ["db-url"]
    "api-gateway"          = ["jwt-signing-key"]
  }

  db_connected_services = toset([
    "auth-service",
    "booking-service",
    "payment-service",
    "user-service",
    "itinerary-service",
    "reporting-service",
    "notification-service",
  ])

  db_service_users = {
    "auth-service"         = "auth_svc"
    "booking-service"      = "booking_svc"
    "payment-service"      = "payment_svc"
    "user-service"         = "user_svc"
    "itinerary-service"    = "itinerary_svc"
    "reporting-service"    = "reporting_svc"
    "notification-service" = "notification_svc"
  }
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

# ── Network data sources ──────────────────────────────────────────────────────

data "aws_vpc" "main" {
  tags = { Environment = local.environment, Name = "${local.environment}-vpc" }
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["public"]
  }
}

data "aws_subnets" "private_app" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["private-app"]
  }
}

data "aws_subnets" "private_data" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["private-data"]
  }
}

data "aws_security_group" "edge_alb" {
  vpc_id = data.aws_vpc.main.id
  filter {
    name   = "tag:Name"
    values = ["${local.environment}-edge-alb-sg"]
  }
}

data "aws_security_group" "internal_alb" {
  vpc_id = data.aws_vpc.main.id
  filter {
    name   = "tag:Name"
    values = ["${local.environment}-internal-alb-sg"]
  }
}

data "aws_security_group" "ecs_tasks_sg" {
  vpc_id = data.aws_vpc.main.id
  filter {
    name   = "tag:Environment"
    values = [local.environment]
  }
  filter {
    name   = "tag:Purpose"
    values = ["ecs-tasks"]
  }
}

data "aws_ecs_cluster" "main" {
  cluster_name = "${local.environment}-travel-platform"
}

data "aws_db_instance" "main" {
  db_instance_identifier = "${local.environment}-travel-platform"
}

data "aws_sns_topic" "alarms" {
  name = "${local.environment}-travel-platform-alarms"
}

# ── KMS module ───────────────────────────────────────────────────────────────

module "kms" {
  source = "../../modules/kms"

  environment    = local.environment
  aws_account_id = local.aws_account_id
  common_tags    = local.common_tags

  allowed_principal_arns = {
    rds            = []
    elasticache    = []
    s3             = []
    sqs            = []
    secretsmanager = []
  }
}

# ── Secrets module ───────────────────────────────────────────────────────────

module "secrets" {
  source = "../../modules/secrets"

  environment         = local.environment
  kms_key_arn         = module.kms.key_arns["secretsmanager"]
  rotation_days       = 90
  common_tags         = local.common_tags
  rotation_lambda_arn = ""
}

# ── SQS queues ───────────────────────────────────────────────────────────────

module "sqs" {
  source = "../../modules/sqs"

  environment   = local.environment
  kms_key_arn   = module.kms.key_arns["sqs"]
  alarm_sns_arn = data.aws_sns_topic.alarms.arn
  common_tags   = local.common_tags
}

# ── RDS Proxy module ──────────────────────────────────────────────────────────

module "rds_proxy" {
  source = "../../modules/rds-proxy"

  environment    = local.environment
  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region

  vpc_id     = data.aws_db_instance.main.db_subnet_group
  subnet_ids = data.aws_subnets.private_app.ids

  rds_instance_identifier = data.aws_db_instance.main.db_instance_identifier
  rds_security_group_id   = data.aws_db_instance.main.vpc_security_groups[0]

  db_secret_arn = module.secrets.secret_arns["db-url"]
  kms_key_arn   = module.kms.key_arns["secretsmanager"]

  db_service_users     = local.db_service_users
  migration_db_user    = "migration_task"
  purge_worker_db_user = "purge_worker"

  max_connections_percent      = 20
  max_idle_connections_percent = 1
  connection_borrow_timeout    = 120

  alarm_sns_arn                        = data.aws_sns_topic.alarms.arn
  borrow_latency_threshold_ms          = 1000
  connection_utilisation_threshold_pct = 80

  common_tags = local.common_tags
}

# ── Database module ───────────────────────────────────────────────────────────

module "database" {
  source = "../../modules/database"

  environment    = local.environment
  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region

  vpc_id                  = data.aws_vpc.main.id
  private_data_subnet_ids = data.aws_subnets.private_data.ids
  service_sg_id           = data.aws_security_group.ecs_tasks_sg.id

  kms_key_arn = module.kms.key_arns["rds"]

  instance_class           = "db.t4g.medium"
  allocated_storage_gb     = 20
  max_allocated_storage_gb = 100
  backup_retention_days    = 7
  deletion_protection      = false

  alarm_sns_arn = data.aws_sns_topic.alarms.arn
  common_tags   = local.common_tags
}

# ── Cache module ──────────────────────────────────────────────────────────────

module "cache" {
  source = "../../modules/cache"

  environment            = local.environment
  vpc_id                 = data.aws_vpc.main.id
  private_app_subnet_ids = data.aws_subnets.private_app.ids
  service_sg_id          = data.aws_security_group.ecs_tasks_sg.id

  kms_key_arn           = module.kms.key_arns["elasticache"]
  redis_auth_secret_arn = module.secrets.secret_arns["redis-auth-token"]

  node_type          = "cache.t4g.small"
  num_cache_clusters = 1

  alarm_sns_arn = data.aws_sns_topic.alarms.arn
  common_tags   = local.common_tags
}

# ── Edge module — CloudFront + WAF + ALBs + target groups ────────────────────

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

module "edge" {
  source = "../../modules/edge"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment    = local.environment
  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region

  vpc_id                 = data.aws_vpc.main.id
  public_subnet_ids      = data.aws_subnets.public.ids
  private_app_subnet_ids = data.aws_subnets.private_app.ids
  edge_alb_sg_id         = data.aws_security_group.edge_alb.id
  internal_alb_sg_id     = data.aws_security_group.internal_alb.id

  domain_name     = var.domain_name
  route53_zone_id = var.route53_zone_id

  waf_log_retention_days = 90
  common_tags            = local.common_tags
}

# ── ECS services ──────────────────────────────────────────────────────────────

module "ecs_service" {
  for_each = local.service_secret_map

  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = each.key
  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region

  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/${each.key}:latest"

  log_group_name     = "/ecs/${local.environment}/${each.key}"
  ecs_cluster_arn    = data.aws_ecs_cluster.main.arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]

  kms_key_arns = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    for slug in each.value :
    upper(replace(slug, "-", "_")) => module.secrets.secret_arns[slug]
  }

  rds_connect_policy_arns = contains(local.db_connected_services, each.key) ? [
    module.rds_proxy.service_rds_connect_policy_arns[each.key]
  ] : []

  target_group_arn = module.edge.target_group_arns[each.key]

  common_tags = local.common_tags
}
