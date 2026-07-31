/**
 * Dev environment ECS service definitions.
 *
 * Mirrors production/services.tf with dev-appropriate sizing:
 *   - FARGATE_SPOT enabled for cost reduction
 *   - desired_count = 1 for all services (no HA requirement in dev)
 *   - Placeholder secrets reference synthetic values (never real credentials)
 *
 * AC11: Placeholder Secrets Manager entries exist with clearly synthetic values
 * (stub-* prefix) so integration tests run without real supplier credentials.
 * The secrets module in dev sets the initial value to the stub strings below.
 */

# ── ECS cluster (Service Connect + Container Insights) ───────────────────────

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  environment                    = local.environment
  enable_fargate_spot            = true  # dev: use SPOT for cost reduction
  fargate_spot_weight            = 3
  fargate_weight                 = 1
  fargate_base                   = 0    # dev: allow all tasks on SPOT
  vpc_id                         = data.aws_vpc.main.id
  service_connect_namespace_name = "${local.environment}.travel.internal"

  common_tags = local.common_tags
}

# ── api-gateway ──────────────────────────────────────────────────────────────

module "api_gateway" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "api-gateway"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/api-gateway:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3000
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/api-gateway"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    JWT_SECRET = module.secrets.secret_arns["jwt-signing-key"]
  }

  environment_vars = {
    NODE_ENV               = local.environment
    PORT                   = "3000"
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

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── auth-service ─────────────────────────────────────────────────────────────

module "auth_service" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "auth-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/auth-service:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3001
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/auth-service"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    JWT_SECRET                 = module.secrets.secret_arns["jwt-signing-key"]
    GOOGLE_OAUTH_CLIENT_ID     = module.secrets.secret_arns["google-oauth-client-id"]
    GOOGLE_OAUTH_CLIENT_SECRET = module.secrets.secret_arns["google-oauth-client-secret"]
    DATABASE_URL               = module.secrets.secret_arns["db-url"]
    REDIS_URL                  = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3001"
  }

  target_group_arn = module.edge.target_group_arns["auth-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["auth-service"]]

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── user-service ─────────────────────────────────────────────────────────────

module "user_service" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "user-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/user-service:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3002
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/user-service"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

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

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── flight-service (search, 1 vCPU / 2 GB in prod; 512/1024 in dev) ──────────

module "flight_service" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "flight-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/flight-service:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3003
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/flight-service"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

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

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── hotel-service ─────────────────────────────────────────────────────────────

module "hotel_service" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "hotel-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/hotel-service:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3004
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/hotel-service"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

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

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── car-service ───────────────────────────────────────────────────────────────

module "car_service" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "car-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/car-service:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3005
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/car-service"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

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

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── booking-service ───────────────────────────────────────────────────────────

module "booking_service" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "booking-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/booking-service:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3006
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/booking-service"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    DATABASE_URL = module.secrets.secret_arns["db-url"]
    REDIS_URL    = module.secrets.secret_arns["redis-auth-token"]
    JWT_SECRET   = module.secrets.secret_arns["jwt-signing-key"]
  }

  environment_vars = {
    NODE_ENV            = local.environment
    PORT                = "3006"
    DB_CONNECTION_LIMIT = "5"
  }

  target_group_arn = module.edge.target_group_arns["booking-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["booking-service"]]

  sqs_producer_queue_arns = [module.sqs.notification_queue_arn]

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── payment-service ───────────────────────────────────────────────────────────

module "payment_service" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "payment-service"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/payment-service:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3007
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/payment-service"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

  # Stub Stripe credentials (AC11 — synthetic values for dev integration tests)
  secret_refs = {
    STRIPE_SECRET_KEY     = module.secrets.secret_arns["stripe-secret-key"]
    STRIPE_WEBHOOK_SECRET = module.secrets.secret_arns["stripe-webhook-secret"]
    DATABASE_URL          = module.secrets.secret_arns["db-url"]
    REDIS_URL             = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV = local.environment
    PORT     = "3007"
  }

  target_group_arn = module.edge.target_group_arns["payment-service"]

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["payment-service"]]

  sqs_producer_queue_arns = [module.sqs.notification_queue_arn]

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── ai-orchestration ─────────────────────────────────────────────────────────

module "ai_orchestration" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "ai-orchestration"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/ai-orchestration:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3008
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/ai-orchestration"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

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

  enable_service_connect        = true
  service_connect_namespace_arn = module.ecs_cluster.service_connect_namespace_arn

  common_tags = local.common_tags
}

# ── notification-consumer — no ingress (AC8) ─────────────────────────────────

module "notification_consumer" {
  source = "../../modules/ecs-service"

  environment     = local.environment
  service_name    = "notification-consumer"
  container_image = "${local.aws_account_id}.dkr.ecr.${local.aws_region}.amazonaws.com/notification-consumer:stub-latest"
  cpu             = 512
  memory          = 1024
  port            = 3009
  desired_count   = 1

  aws_account_id     = local.aws_account_id
  aws_region         = local.aws_region
  log_group_name     = "/ecs/${local.environment}/notification-consumer"
  ecs_cluster_arn    = module.ecs_cluster.cluster_arn
  subnet_ids         = data.aws_subnets.private_app.ids
  security_group_ids = [data.aws_security_group.ecs_tasks_sg.id]
  kms_key_arns       = [module.kms.key_arns["secretsmanager"]]

  secret_refs = {
    DATABASE_URL = module.secrets.secret_arns["db-url"]
    REDIS_URL    = module.secrets.secret_arns["redis-auth-token"]
  }

  environment_vars = {
    NODE_ENV     = local.environment
    PORT         = "3009"
    QUEUE_DRIVER = "sqs"
  }

  # No target_group_arn — no ALB attachment (AC8)

  rds_connect_policy_arns = [module.rds_proxy.service_rds_connect_policy_arns["notification-service"]]

  sqs_consumer_queue_arns = [module.sqs.notification_queue_arn]

  enable_service_connect = false

  common_tags = local.common_tags
}
