/**
 * ECS Fargate service definitions — ten components of the travel platform.
 *
 * Sizing rationale (AC2):
 *   api-gateway         2 vCPU / 4 GB   — fan-out to all internal services, JWT validation
 *   auth-service        512 CPU / 1 GB  — stateless JWT; scales horizontally
 *   user-service        512 CPU / 1 GB  — CRUD; low compute
 *   flight-service      1 vCPU / 2 GB   — search; Amadeus JSON parsing is CPU-intensive
 *   hotel-service       1 vCPU / 2 GB   — search; same rationale as flight
 *   car-service         1 vCPU / 2 GB   — search; same rationale as flight
 *   booking-service     1 vCPU / 2 GB   — orchestrates traveler + payment; moderate load
 *   payment-service     512 CPU / 1 GB  — thin Stripe proxy; I/O bound not CPU bound
 *   ai-orchestration    2 vCPU / 4 GB   — Anthropic streaming; long-lived connections
 *   notification-consumer 512 CPU / 1 GB — SQS poller; no ingress
 *
 * IAM boundaries (AC3):
 *   Only payment-service receives the Stripe secret ARN in its secret_refs.
 *   Only flight/hotel/car receive Amadeus and RapidAPI keys.
 *   Only ai-orchestration receives the Anthropic key.
 *   Only notification-consumer has sqs_consumer_queue_arns.
 *   booking/payment have sqs_producer_queue_arns.
 *
 * Credentials policy (AC4):
 *   ALL credentials are supplied via secret_refs (ECS secrets block → valueFrom ARNs).
 *   The environment_vars validation in the module rejects keys matching SECRET|KEY|TOKEN|PASSWORD.
 *
 * notification-consumer (AC8):
 *   target_group_arn is omitted (defaults to "") so no load balancer is attached.
 */

# ── ECS cluster (Service Connect namespace + Container Insights) ──────────────

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  environment                    = local.environment
  enable_fargate_spot            = false  # production: FARGATE only for stability
  vpc_id                         = data.aws_vpc.main.id
  service_connect_namespace_name = "${local.environment}.travel.internal"

  common_tags = local.common_tags
}

# ── api-gateway — public ingress, 2 vCPU / 4 GB ──────────────────────────────

module "api_gateway" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "api-gateway"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/api-gateway:latest"
  cpu            = 2048
  memory         = 4096
  port           = 3000
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/api-gateway"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    JWT_SECRET = module.secrets.secret_arns["jwt-signing-key"]
  }

  environment_vars = {
    NODE_ENV         = local.environment
    PORT             = "3000"
    # Internal service URLs resolved via Service Connect DNS aliases
    AUTH_SERVICE_URL       = "http://auth-service:3001"
    USER_SERVICE_URL       = "http://user-service:3002"
    FLIGHT_SERVICE_URL     = "http://flight-service:3003"
    HOTEL_SERVICE_URL      = "http://hotel-service:3004"
    CAR_SERVICE_URL        = "http://car-service:3005"
    BOOKING_SERVICE_URL    = "http://booking-service:3006"
    PAYMENT_SERVICE_URL    = "http://payment-service:3007"
    AI_SERVICE_URL         = "http://ai-orchestration:3008"
  }

  target_group_arn = module.edge.target_group_arns["api-gateway"]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "api-gateway"

  # ai-orchestration streaming: keep idle timeout above SSE window
  health_check_start_period = 45

  common_tags = local.common_tags
}

# ── auth-service — 512 CPU / 1 GB ────────────────────────────────────────────

module "auth_service" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "auth-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/auth-service:latest"
  cpu            = 512
  memory         = 1024
  port           = 3001
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/auth-service"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    JWT_SECRET                = module.secrets.secret_arns["jwt-signing-key"]
    GOOGLE_OAUTH_CLIENT_ID     = module.secrets.secret_arns["google-oauth-client-id"]
    GOOGLE_OAUTH_CLIENT_SECRET = module.secrets.secret_arns["google-oauth-client-secret"]
    DATABASE_URL              = module.secrets.secret_arns["db-url"]
    REDIS_URL                 = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3001"
  }

  target_group_arn = module.edge.target_group_arns["auth-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["auth-service"]]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "auth-service"

  common_tags = local.common_tags
}

# ── user-service — 512 CPU / 1 GB ────────────────────────────────────────────

module "user_service" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "user-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/user-service:latest"
  cpu            = 512
  memory         = 1024
  port           = 3002
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/user-service"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    DATABASE_URL = module.secrets.secret_arns["db-url"]
    REDIS_URL    = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3002"
  }

  target_group_arn = module.edge.target_group_arns["user-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["user-service"]]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "user-service"

  common_tags = local.common_tags
}

# ── flight-service — search, 1 vCPU / 2 GB ───────────────────────────────────

module "flight_service" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "flight-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/flight-service:latest"
  cpu            = 1024
  memory         = 2048
  port           = 3003
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/flight-service"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    AMADEUS_CLIENT_ID     = module.secrets.secret_arns["amadeus-client-id"]
    AMADEUS_CLIENT_SECRET = module.secrets.secret_arns["amadeus-client-secret"]
    RAPIDAPI_KEY          = module.secrets.secret_arns["rapidapi-key"]
    REDIS_URL             = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3003"
  }

  target_group_arn = module.edge.target_group_arns["flight-service"]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "flight-service"

  common_tags = local.common_tags
}

# ── hotel-service — search, 1 vCPU / 2 GB ────────────────────────────────────

module "hotel_service" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "hotel-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/hotel-service:latest"
  cpu            = 1024
  memory         = 2048
  port           = 3004
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/hotel-service"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    AMADEUS_CLIENT_ID     = module.secrets.secret_arns["amadeus-client-id"]
    AMADEUS_CLIENT_SECRET = module.secrets.secret_arns["amadeus-client-secret"]
    RAPIDAPI_KEY          = module.secrets.secret_arns["rapidapi-key"]
    REDIS_URL             = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3004"
  }

  target_group_arn = module.edge.target_group_arns["hotel-service"]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "hotel-service"

  common_tags = local.common_tags
}

# ── car-service — search, 1 vCPU / 2 GB ──────────────────────────────────────

module "car_service" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "car-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/car-service:latest"
  cpu            = 1024
  memory         = 2048
  port           = 3005
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/car-service"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    AMADEUS_CLIENT_ID     = module.secrets.secret_arns["amadeus-client-id"]
    AMADEUS_CLIENT_SECRET = module.secrets.secret_arns["amadeus-client-secret"]
    RAPIDAPI_KEY          = module.secrets.secret_arns["rapidapi-key"]
    REDIS_URL             = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3005"
  }

  target_group_arn = module.edge.target_group_arns["car-service"]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "car-service"

  common_tags = local.common_tags
}

# ── booking-service — 1 vCPU / 2 GB ──────────────────────────────────────────

module "booking_service" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "booking-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/booking-service:latest"
  cpu            = 1024
  memory         = 2048
  port           = 3006
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/booking-service"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    DATABASE_URL = module.secrets.secret_arns["db-url"]
    REDIS_URL    = module.secrets.secret_arns["redis-auth-token"]
    JWT_SECRET   = module.secrets.secret_arns["jwt-signing-key"]
  }

  environment_vars = {
    NODE_ENV    = local.environment
    PORT        = "3006"
    # Prisma: connection limit + proxy endpoint injected at deploy time
    DB_CONNECTION_LIMIT = "5"
  }

  target_group_arn = module.edge.target_group_arns["booking-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["booking-service"]]

  # Booking produces notification events
  sqs_producer_queue_arns = [module.sqs.notification_queue_arn]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "booking-service"

  common_tags = local.common_tags
}

# ── payment-service — 512 CPU / 1 GB ─────────────────────────────────────────
# Only this service receives the Stripe secret ARN (AC3 IAM isolation).

module "payment_service" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "payment-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/payment-service:latest"
  cpu            = 512
  memory         = 1024
  port           = 3007
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/payment-service"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  # Stripe secrets — payment-service only (AC3 positive case).
  # flight-service, hotel-service, car-service never receive these ARNs.
  secret_refs = {
    STRIPE_SECRET_KEY      = module.secrets.secret_arns["stripe-secret-key"]
    STRIPE_WEBHOOK_SECRET  = module.secrets.secret_arns["stripe-webhook-secret"]
    DATABASE_URL           = module.secrets.secret_arns["db-url"]
    REDIS_URL              = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3007"
  }

  target_group_arn = module.edge.target_group_arns["payment-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["payment-service"]]

  sqs_producer_queue_arns = [module.sqs.notification_queue_arn]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "payment-service"

  common_tags = local.common_tags
}

# ── ai-orchestration — streaming, 2 vCPU / 4 GB ──────────────────────────────
# SSE streams require long-lived connections; ALB idle timeout must exceed
# the streaming window (configured on the edge module target group).

module "ai_orchestration" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "ai-orchestration"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/ai-orchestration:latest"
  cpu            = 2048
  memory         = 4096
  port           = 3008
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/ai-orchestration"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    ANTHROPIC_API_KEY = module.secrets.secret_arns["anthropic-key"]
    DATABASE_URL      = module.secrets.secret_arns["db-url"]
    REDIS_URL         = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3008"
  }

  target_group_arn = module.edge.target_group_arns["ai-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["user-service"]]

  enable_service_connect         = true
  service_connect_namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
  service_connect_discovery_name = "ai-orchestration"

  # Extend start period for model-client initialisation
  health_check_start_period = 60

  common_tags = local.common_tags
}

# ── notification-consumer — SQS poller, no ingress (AC8) ─────────────────────
# No target_group_arn — this service has no ALB listener and no public path.
# It scales on SQS queue depth, not HTTP requests.

module "notification_consumer" {
  source = "../../modules/ecs-service"

  environment    = local.environment
  service_name   = "notification-consumer"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/notification-consumer:latest"
  cpu            = 512
  memory         = 1024
  port           = 3009
  desired_count  = 2

  aws_account_id = local.aws_account_id
  aws_region     = local.aws_region
  log_group_name = "/ecs/${local.environment}/notification-consumer"
  ecs_cluster_arn = module.ecs_cluster.cluster_arn
  subnet_ids     = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns   = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    DATABASE_URL = module.secrets.secret_arns["db-url"]
    REDIS_URL    = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV   = local.environment
    PORT       = "3009"
    QUEUE_DRIVER = "sqs"
  }

  # No target_group_arn — notification-consumer has no load balancer attachment.
  # AC8: no ingress path.

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["notification-service"]]

  sqs_consumer_queue_arns = [module.sqs.notification_queue_arn]

  # notification-consumer does not register with Service Connect as a server
  # (no inbound HTTP), but uses Service Connect as a client to reach other services.
  enable_service_connect        = false

  common_tags = local.common_tags
}
