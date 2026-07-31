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

  common_tags = local.common_tags
}
