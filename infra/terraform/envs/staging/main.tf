/**
 * Staging environment root module.
 *
 * Wires together the kms, secrets, sqs, rds-proxy, and ecs-service modules
 * for the staging account. ECS cluster, VPC, subnet, and security-group IDs
 * are read from data sources rather than hardcoded so this file does not
 * encode environment-specific IDs that belong in remote state or SSM.
 *
 * Manual approval gate: Terraform apply to staging requires a pull-request
 * approval from a reviewer other than the PR author (enforced by the Forge
 * Shipping pipeline's approval step, not by Terraform itself).
 */

locals {
  environment    = "staging"
  aws_account_id = data.aws_caller_identity.current.account_id
  aws_region     = data.aws_region.current.name

  common_tags = {
    Project     = "travel-platform"
    Environment = local.environment
    ManagedBy   = "terraform"
  }

  # Services and the logical credentials each requires.
  # Format: service-name => list of secret slugs from the secrets module.
  service_secret_map = {
    "auth-service"          = ["jwt-signing-key", "google-oauth-client-id", "google-oauth-client-secret"]
    "booking-service"       = ["db-url", "redis-auth-token"]
    "search-service"        = ["amadeus-client-id", "amadeus-client-secret", "rapidapi-key"]
    "payment-service"       = ["stripe-secret-key", "stripe-webhook-secret"]
    "ai-service"            = ["anthropic-key"]
    "user-service"          = ["db-url"]
    "itinerary-service"     = ["db-url"]
    "reporting-service"     = ["db-url"]
    "notification-service"  = ["db-url"]
    "api-gateway"           = ["jwt-signing-key"]
  }

  # Services that connect to PostgreSQL through RDS Proxy.
  # Must be a subset of service_secret_map keys.
  db_connected_services = toset([
    "auth-service",
    "booking-service",
    "payment-service",
    "user-service",
    "itinerary-service",
    "reporting-service",
    "notification-service",
  ])

  # PostgreSQL role each service authenticates as through the proxy.
  # Roles are created via the DB migration runbook, not Terraform.
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

data "aws_ecs_cluster" "main" {
  cluster_name = "${local.environment}-travel-platform"
}

data "aws_subnets" "private" {
  filter {
    name   = "tag:Environment"
    values = [local.environment]
  }
  filter {
    name   = "tag:Tier"
    values = ["private"]
  }
}

data "aws_security_groups" "ecs_tasks" {
  filter {
    name   = "tag:Environment"
    values = [local.environment]
  }
  filter {
    name   = "tag:Purpose"
    values = ["ecs-tasks"]
  }
}

# RDS instance — read from remote state so this module does not own the RDS
# lifecycle. The RDS instance must be created before applying this module.
data "aws_db_instance" "main" {
  db_instance_identifier = "${local.environment}-travel-platform"
}

# ── KMS module ───────────────────────────────────────────────────────────────

module "kms" {
  source = "../../modules/kms"

  environment    = local.environment
  aws_account_id = local.aws_account_id
  common_tags    = local.common_tags

  # Grant the task execution roles decrypt access once the ECS module outputs
  # are available (two-step bootstrap: apply kms first, then ecs-service).
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

  environment    = local.environment
  kms_key_arn    = module.kms.key_arns["secretsmanager"]
  rotation_days  = 90
  common_tags    = local.common_tags

  # rotation_lambda_arn left empty at bootstrap; set once the rotation Lambda
  # is deployed to the account.
  rotation_lambda_arn = ""
}

# ── SQS queues ───────────────────────────────────────────────────────────────

# Look up the SNS alarm topic created by monitoring.tf (expected to exist in
# the same account/region; created independently of this module).
data "aws_sns_topic" "alarms" {
  name = "${local.environment}-travel-platform-alarms"
}

module "sqs" {
  source = "../../modules/sqs"

  environment   = local.environment
  kms_key_arn   = module.kms.key_arns["sqs"]
  alarm_sns_arn = data.aws_sns_topic.alarms.arn
  common_tags   = local.common_tags
}

# ── RDS Proxy module ──────────────────────────────────────────────────────────
# Connection budget is documented in:
#   infra/terraform/modules/rds-proxy/connection-budget.md

module "rds_proxy" {
  source = "../../modules/rds-proxy"

  environment    = local.environment
  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region

  vpc_id     = data.aws_db_instance.main.db_subnet_group
  subnet_ids = data.aws_subnets.private.ids

  rds_instance_identifier = data.aws_db_instance.main.db_instance_identifier
  rds_security_group_id   = data.aws_db_instance.main.vpc_security_groups[0]

  # Secrets Manager secret holding the RDS master credentials (username/password).
  db_secret_arn = module.secrets.secret_arns["db-url"]
  kms_key_arn   = module.kms.key_arns["secretsmanager"]

  # Per-service DB users for IAM-authenticated rds-db:connect policies.
  db_service_users    = local.db_service_users
  migration_db_user   = "migration_task"
  purge_worker_db_user = "purge_worker"

  # Connection pool tuning — see connection-budget.md for derivation.
  max_connections_percent      = 20
  max_idle_connections_percent = 1
  connection_borrow_timeout    = 120

  alarm_sns_arn                        = data.aws_sns_topic.alarms.arn
  borrow_latency_threshold_ms          = 1000
  connection_utilisation_threshold_pct = 80

  common_tags = local.common_tags
}

# ── Network foundation data sources ──────────────────────────────────────────

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

# ── Edge module — CloudFront + WAF + ALBs + target groups (WO-080) ───────────

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

  waf_log_retention_days = 365
  common_tags            = local.common_tags
}

# ── Database data-tier subnets ───────────────────────────────────────────────

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

# ── Database module — RDS PostgreSQL 16 Multi-AZ (WO-083) ────────────────────

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

# ── Cache module — ElastiCache Redis 7 (WO-083) ───────────────────────────────

module "cache" {
  source = "../../modules/cache"

  environment            = local.environment
  vpc_id                 = data.aws_vpc.main.id
  private_app_subnet_ids = data.aws_subnets.private_app.ids
  service_sg_id          = data.aws_security_group.ecs_tasks_sg.id

  kms_key_arn           = module.kms.key_arns["elasticache"]
  redis_auth_secret_arn = module.secrets.secret_arns["redis-auth-token"]

  node_type          = "cache.r7g.large"
  num_cache_clusters = 2

  alarm_sns_arn = data.aws_sns_topic.alarms.arn
  common_tags   = local.common_tags
}

# ── ECS services ─────────────────────────────────────────────────────────────

module "ecs_service" {
  for_each = local.service_secret_map

  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = each.key
  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region

  # Placeholder image — real deployments update this via the CI/CD pipeline,
  # not through Terraform (lifecycle ignore_changes on task_definition).
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/${each.key}:latest"

  log_group_name     = "/ecs/${local.environment}/${each.key}"
  ecs_cluster_arn    = data.aws_ecs_cluster.main.arn
  subnet_ids         = data.aws_subnets.private.ids
  security_group_ids = data.aws_security_groups.ecs_tasks.ids

  kms_key_arns = [module.kms.key_arns["secretsmanager"]]

  # Inject only the secrets this service requires. ARNs looked up from the
  # secrets module output by slug.
  secret_refs = {
    for slug in each.value :
    upper(replace(slug, "-", "_")) => module.secrets.secret_arns[slug]
  }

  # Attach rds-db:connect IAM policy for services that connect through the
  # proxy.  Services not in db_connected_services receive an empty list.
  rds_connect_policy_arns = contains(local.db_connected_services, each.key) ? [
    module.rds_proxy.service_rds_connect_policy_arns[each.key]
  ] : []

  # Register the service with its ALB target group. Target groups are created
  # by the edge module (WO-080) with /health/ready health checks.
  target_group_arn = module.edge.target_group_arns[each.key]

  common_tags = local.common_tags
}
