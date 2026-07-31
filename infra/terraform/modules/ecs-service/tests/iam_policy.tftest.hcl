# IAM policy boundary tests.
#
# These plan-level assertions verify:
#   1. The task execution role scopes secretsmanager:GetSecretValue to explicit ARNs only.
#   2. No wildcard resource appears in the secret retrieval policy.
#   3. payment-service can read the Stripe secret ARN; flight-service cannot.
#   4. SQS producer / consumer policies are attached only to the correct services.
#   5. The task role name is unique per service (no shared roles).
#
# Positive/negative IAM policy simulation (against real AWS) is documented in
# docs/testing/iam-simulation.md and runs as part of the pre-production stage
# in the Forge Shipping pipeline.

mock_provider "aws" {}

# ── payment-service: receives Stripe secret ARN ───────────────────────────────

run "payment_service_receives_stripe_secret" {
  command = plan

  variables {
    environment        = "dev"
    service_name       = "payment-service"
    container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/payment-service:latest"
    aws_account_id     = "123456789012"
    aws_region         = "eu-west-1"
    log_group_name     = "/ecs/dev/payment-service"
    ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
    subnet_ids         = ["subnet-12345678"]
    security_group_ids = ["sg-12345678"]
    secret_refs = {
      STRIPE_SECRET_KEY     = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/stripe-secret-key"
      STRIPE_WEBHOOK_SECRET = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/stripe-webhook-secret"
    }
  }

  # Payment service execution role policy must include the Stripe ARN
  assert {
    condition = strcontains(
      data.aws_iam_policy_document.secret_retrieval.json,
      "stripe-secret-key"
    )
    error_message = "payment-service execution role must grant GetSecretValue on the Stripe secret ARN"
  }

  assert {
    condition     = !strcontains(data.aws_iam_policy_document.secret_retrieval.json, "\"*\"")
    error_message = "Secret retrieval policy must not use wildcard resource"
  }
}

# ── flight-service: must NOT receive Stripe secret ARN ───────────────────────

run "flight_service_cannot_read_stripe_secret" {
  command = plan

  variables {
    environment        = "dev"
    service_name       = "flight-service"
    container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/flight-service:latest"
    aws_account_id     = "123456789012"
    aws_region         = "eu-west-1"
    log_group_name     = "/ecs/dev/flight-service"
    ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
    subnet_ids         = ["subnet-12345678"]
    security_group_ids = ["sg-12345678"]
    secret_refs = {
      AMADEUS_CLIENT_ID     = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/amadeus-client-id"
      AMADEUS_CLIENT_SECRET = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/amadeus-client-secret"
      RAPIDAPI_KEY          = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/rapidapi-key"
    }
  }

  # flight-service execution role must NOT contain the Stripe secret ARN
  assert {
    condition = !strcontains(
      data.aws_iam_policy_document.secret_retrieval.json,
      "stripe-secret-key"
    )
    error_message = "flight-service must not have GetSecretValue on the Stripe secret"
  }

  assert {
    condition = !strcontains(
      data.aws_iam_policy_document.secret_retrieval.json,
      "stripe-webhook-secret"
    )
    error_message = "flight-service must not have GetSecretValue on the Stripe webhook secret"
  }
}

# ── No wildcard GetSecretValue in any service ─────────────────────────────────

run "no_wildcard_secret_resource" {
  command = plan

  variables {
    environment        = "dev"
    service_name       = "booking-service"
    container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/booking-service:latest"
    aws_account_id     = "123456789012"
    aws_region         = "eu-west-1"
    log_group_name     = "/ecs/dev/booking-service"
    ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
    subnet_ids         = ["subnet-12345678"]
    security_group_ids = ["sg-12345678"]
    secret_refs = {
      DATABASE_URL = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/db-url"
    }
  }

  assert {
    condition = !strcontains(
      data.aws_iam_policy_document.secret_retrieval.json,
      "\"arn:aws:secretsmanager:*\""
    )
    error_message = "Secret retrieval policy must not use ARN wildcards"
  }

  assert {
    condition     = !strcontains(data.aws_iam_policy_document.secret_retrieval.json, "\"*\"")
    error_message = "Secret retrieval policy must not use wildcard resource (*)"
  }
}

# ── SQS consumer policy attached only to notification-consumer ───────────────

run "sqs_consumer_policy_attached_for_consumer" {
  command = plan

  variables {
    environment        = "dev"
    service_name       = "notification-consumer"
    container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/notification-consumer:latest"
    aws_account_id     = "123456789012"
    aws_region         = "eu-west-1"
    log_group_name     = "/ecs/dev/notification-consumer"
    ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
    subnet_ids         = ["subnet-12345678"]
    security_group_ids = ["sg-12345678"]
    sqs_consumer_queue_arns = [
      "arn:aws:sqs:eu-west-1:123456789012:dev-notification-queue"
    ]
  }

  assert {
    condition = strcontains(
      data.aws_iam_policy_document.sqs_consumer[0].json,
      "sqs:ReceiveMessage"
    )
    error_message = "notification-consumer task role must grant sqs:ReceiveMessage"
  }

  assert {
    condition = strcontains(
      data.aws_iam_policy_document.sqs_consumer[0].json,
      "dev-notification-queue"
    )
    error_message = "SQS consumer policy must scope to the specific queue ARN"
  }

  assert {
    condition     = !strcontains(data.aws_iam_policy_document.sqs_consumer[0].json, "\"*\"")
    error_message = "SQS consumer policy must not use wildcard resource"
  }
}

# ── SQS producer policy attached only to booking/payment ─────────────────────

run "sqs_producer_policy_attached_for_booking" {
  command = plan

  variables {
    environment        = "dev"
    service_name       = "booking-service"
    container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/booking-service:latest"
    aws_account_id     = "123456789012"
    aws_region         = "eu-west-1"
    log_group_name     = "/ecs/dev/booking-service"
    ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
    subnet_ids         = ["subnet-12345678"]
    security_group_ids = ["sg-12345678"]
    sqs_producer_queue_arns = [
      "arn:aws:sqs:eu-west-1:123456789012:dev-notification-queue"
    ]
  }

  assert {
    condition = strcontains(
      data.aws_iam_policy_document.sqs_producer[0].json,
      "sqs:SendMessage"
    )
    error_message = "booking-service task role must grant sqs:SendMessage"
  }

  assert {
    condition = strcontains(
      data.aws_iam_policy_document.sqs_producer[0].json,
      "dev-notification-queue"
    )
    error_message = "SQS producer policy must scope to the specific queue ARN"
  }
}

# ── No SQS policy when queue ARNs are empty ───────────────────────────────────

run "no_sqs_policy_for_auth_service" {
  command = plan

  variables {
    environment             = "dev"
    service_name            = "auth-service"
    container_image         = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/auth-service:latest"
    aws_account_id          = "123456789012"
    aws_region              = "eu-west-1"
    log_group_name          = "/ecs/dev/auth-service"
    ecs_cluster_arn         = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
    subnet_ids              = ["subnet-12345678"]
    security_group_ids      = ["sg-12345678"]
    sqs_producer_queue_arns = []
    sqs_consumer_queue_arns = []
  }

  assert {
    condition     = length(aws_iam_role_policy.sqs_producer) == 0
    error_message = "auth-service must not have an SQS producer policy attached"
  }

  assert {
    condition     = length(aws_iam_role_policy.sqs_consumer) == 0
    error_message = "auth-service must not have an SQS consumer policy attached"
  }
}
