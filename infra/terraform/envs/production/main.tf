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

# ── ECS services ─────────────────────────────────────────────────────────────

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
  subnet_ids         = data.aws_subnets.private.ids
  security_group_ids = data.aws_security_groups.ecs_tasks.ids

  kms_key_arns = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    for slug in each.value :
    upper(replace(slug, "-", "_")) => module.secrets.secret_arns[slug]
  }

  rds_connect_policy_arns = contains(local.db_connected_services, each.key) ? [
    module.rds_proxy.service_rds_connect_policy_arns[each.key]
  ] : []

  common_tags = local.common_tags
}
