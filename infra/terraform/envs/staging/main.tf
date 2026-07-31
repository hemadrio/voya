/**
 * Staging environment root module.
 *
 * Wires together the kms, secrets, and ecs-service modules for the staging
 * account. ECS cluster, VPC, subnet, and security-group IDs are read from
 * data sources rather than hardcoded so this file does not encode
 * environment-specific IDs that belong in remote state or SSM.
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

  common_tags = local.common_tags
}
