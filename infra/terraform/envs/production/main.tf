/**
 * Production environment root module.
 *
 * Identical structure to staging/main.tf with production-specific values.
 *
 * Manual approval gate: Terraform apply to production requires a pull-request
 * approval from a reviewer other than the PR author AND a second approval from
 * a security engineer. The Forge Shipping pipeline enforces this via its
 * production-promote approval step; the author may not self-approve.
 */

locals {
  environment    = "production"
  aws_account_id = data.aws_caller_identity.current.account_id
  aws_region     = data.aws_region.current.name

  common_tags = {
    Project     = "travel-platform"
    Environment = local.environment
    ManagedBy   = "terraform"
  }

  # ── Autoscaling thresholds (WO-082) ────────────────────────────────────────
  # ALB step-scaling trigger: RequestCountPerTarget sum over one 60-second period.
  # ~60 rps per search task × 10 tasks = 600 rps steady-state; 1000 provides 67%
  # headroom before acceleration kicks in.
  threshold_alb_request_count_per_target = 1000

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

data "aws_db_instance" "main" {
  db_instance_identifier = "${local.environment}-travel-platform"
}

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

module "secrets" {
  source = "../../modules/secrets"

  environment   = local.environment
  kms_key_arn   = module.kms.key_arns["secretsmanager"]
  rotation_days = 90
  common_tags   = local.common_tags

  rotation_lambda_arn = ""
}

# ── SQS queues ───────────────────────────────────────────────────────────────

data "aws_sns_topic" "alarms" {
  name = "${local.environment}-travel-platform-alarms"
}

# On-call paging topic — used by DLQ alarms in addition to the ticket topic.
# Created by infra/terraform/sns.tf in the root monitoring stack.
data "aws_sns_topic" "platform_page" {
  name = "${local.environment}-platform-page"
}

module "sqs" {
  source = "../../modules/sqs"

  environment    = local.environment
  kms_key_arn    = module.kms.key_arns["sqs"]
  alarm_sns_arn  = data.aws_sns_topic.alarms.arn
  oncall_sns_arn = data.aws_sns_topic.platform_page.arn
  common_tags    = local.common_tags
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

# ── Network foundation ────────────────────────────────────────────────────────
# The network module (WO-079) is the source of truth for VPC/subnet/SG IDs.
# Read them via data sources rather than module outputs so this root module
# does not depend on a prior apply of the network module in the same run.

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
    aws          = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment    = local.environment
  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region

  vpc_id                  = data.aws_vpc.main.id
  public_subnet_ids       = data.aws_subnets.public.ids
  private_app_subnet_ids  = data.aws_subnets.private_app.ids
  edge_alb_sg_id          = data.aws_security_group.edge_alb.id
  internal_alb_sg_id      = data.aws_security_group.internal_alb.id

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

  instance_class             = "db.r6g.large"
  allocated_storage_gb       = 100
  max_allocated_storage_gb   = 500
  backup_retention_days      = 35
  deletion_protection        = true

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

# ── ECS services and cluster — see services.tf ────────────────────────────────
# Individual service definitions with per-component sizing, secret boundaries,
# and Service Connect configuration are in services.tf.
# The ecs-cluster module (cluster + namespace) is also declared in services.tf.
