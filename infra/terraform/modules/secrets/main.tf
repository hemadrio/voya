/**
 * Secrets Manager — one secret per logical credential.
 *
 * Values are NEVER committed to the repository; they are supplied out-of-band
 * via the AWS Console, CI/CD OIDC role, or a separate bootstrap script.
 * lifecycle ignore_changes on secret_string prevents Terraform from
 * overwriting a value that was rotated outside of Terraform.
 *
 * Rotation: every rotatable secret gets an aws_secretsmanager_secret_rotation
 * resource pointing at the shared rotation Lambda. The maximum cadence is 90
 * days per the security policy (variable.rotation_days).
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ── Logical credentials ──────────────────────────────────────────────────────
# 11 secrets covering every service credential. Keys are the slug used in ARN
# references; descriptions are human-readable for the Secrets Manager console.

locals {
  secrets = {
    "db-url" = {
      description  = "PostgreSQL connection URL for the primary RDS cluster"
      owning_service = "booking-service"
      classification = "Restricted"
      rotatable    = true
    }
    "redis-auth-token" = {
      description  = "Redis AUTH token for the ElastiCache cluster"
      owning_service = "booking-service"
      classification = "Restricted"
      rotatable    = true
    }
    "jwt-signing-key" = {
      description  = "JWT RS256 private key material (PEM). Two-phase rotation with 24 h overlap."
      owning_service = "auth-service"
      classification = "Restricted"
      rotatable    = true
    }
    "stripe-secret-key" = {
      description  = "Stripe secret API key (sk_live_... or sk_test_...)"
      owning_service = "payment-service"
      classification = "Restricted"
      rotatable    = true
    }
    "stripe-webhook-secret" = {
      description  = "Stripe webhook signing secret (whsec_...)"
      owning_service = "payment-service"
      classification = "Restricted"
      rotatable    = false
    }
    "amadeus-client-id" = {
      description  = "Amadeus API OAuth2 client ID"
      owning_service = "search-service"
      classification = "Restricted"
      rotatable    = true
    }
    "amadeus-client-secret" = {
      description  = "Amadeus API OAuth2 client secret"
      owning_service = "search-service"
      classification = "Restricted"
      rotatable    = true
    }
    "rapidapi-key" = {
      description  = "RapidAPI subscription key for flight-price aggregation"
      owning_service = "search-service"
      classification = "Restricted"
      rotatable    = true
    }
    "anthropic-key" = {
      description  = "Anthropic API key for Claude-backed itinerary generation"
      owning_service = "ai-service"
      classification = "Restricted"
      rotatable    = true
    }
    "google-oauth-client-id" = {
      description  = "Google OAuth 2.0 client ID for user authentication"
      owning_service = "auth-service"
      classification = "Restricted"
      rotatable    = false
    }
    "google-oauth-client-secret" = {
      description  = "Google OAuth 2.0 client secret for user authentication"
      owning_service = "auth-service"
      classification = "Restricted"
      rotatable    = true
    }
  }

  rotatable_secrets = {
    for slug, cfg in local.secrets : slug => cfg if cfg.rotatable
  }

  # Per-service PostgreSQL users that authenticate through RDS Proxy.
  # Each service gets its own Secrets Manager secret so IAM policies can be
  # scoped per-service and connection_limit=5 is enforced at the Prisma layer.
  db_service_users = {
    "auth-service"         = "auth_svc"
    "booking-service"      = "booking_svc"
    "payment-service"      = "payment_svc"
    "user-service"         = "user_svc"
    "itinerary-service"    = "itinerary_svc"
    "reporting-service"    = "reporting_svc"
    "notification-service" = "notification_svc"
  }

  # Connection string template. The proxy_endpoint is substituted when known;
  # operators must replace the placeholder password with the real credential.
  # connection_limit=5 caps Prisma's internal pool per task — critical for
  # preventing connection exhaustion when multiple replicas run simultaneously.
  proxy_host = var.proxy_endpoint != "" ? var.proxy_endpoint : "<proxy-endpoint>"
}

# ── Secret resources ─────────────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "credential" {
  for_each = local.secrets

  name        = "${var.environment}/travel-platform/${each.key}"
  description = each.value.description
  kms_key_id  = var.kms_key_arn

  # Protects against accidental deletion; requires two-step recovery in console.
  recovery_window_in_days = 30

  tags = merge(var.common_tags, {
    Name           = "${var.environment}-${each.key}"
    Environment    = var.environment
    OwningService  = each.value.owning_service
    Classification = each.value.classification
    ManagedBy      = "terraform"
  })

  lifecycle {
    # Rotation and manual updates set the value out-of-band; Terraform must not
    # overwrite it on subsequent applies or treat a missing initial value as drift.
    ignore_changes = [secret_string]
  }
}

# ── Per-service Prisma connection strings ─────────────────────────────────────
# One secret per DB-connected service so operators can scope IAM GetSecretValue
# policies per service and so the connection_limit=5 is embedded in each value.
#
# Initial value uses a template with clear placeholders; operators (or the
# rotation Lambda) replace it after the RDS Proxy endpoint is provisioned.
# lifecycle.ignore_changes prevents Terraform from overwriting rotated values.

resource "aws_secretsmanager_secret" "prisma_db_url" {
  for_each = local.db_service_users

  name        = "${var.environment}/travel-platform/${each.key}/db-url"
  description = "Prisma DATABASE_URL for ${each.key}. Value must follow the template: postgresql://${each.value}:<password>@<proxy-endpoint>:5432/travel?connection_limit=5&pgbouncer=false&sslmode=require"
  kms_key_id  = var.kms_key_arn

  recovery_window_in_days = 30

  tags = merge(var.common_tags, {
    Name           = "${var.environment}-${each.key}-db-url"
    Environment    = var.environment
    OwningService  = each.key
    Classification = "Restricted"
    ManagedBy      = "terraform"
    ConnectionLimit = "5"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret_version" "prisma_db_url_placeholder" {
  for_each = local.db_service_users

  secret_id = aws_secretsmanager_secret.prisma_db_url[each.key].id

  # Placeholder template. The proxy_endpoint variable is substituted when
  # provided; otherwise the literal placeholder reminds operators what to set.
  # connection_limit=5: caps the Prisma connection pool per ECS task replica,
  # preventing exhaustion when db.r6g.large max_connections (~1802) is shared
  # across services. pgbouncer=false: Prisma must NOT re-enable its built-in
  # pgbouncer mode against RDS Proxy (double-pooling causes prepared statement
  # incompatibility). sslmode=require: enforces TLS to the proxy.
  secret_string = jsonencode({
    username = each.value
    password = "REPLACE_WITH_ACTUAL_PASSWORD"
    host     = local.proxy_host
    port     = 5432
    database = "travel"
    url      = "postgresql://${each.value}:REPLACE_WITH_ACTUAL_PASSWORD@${local.proxy_host}:5432/travel?connection_limit=5&pgbouncer=false&sslmode=require"
  })

  lifecycle {
    # Operators and the rotation Lambda update the secret_string out-of-band;
    # Terraform must not overwrite a live rotated value.
    ignore_changes = [secret_string]
  }
}

# ── Rotation ─────────────────────────────────────────────────────────────────
# Only created when a rotation Lambda ARN is provided. Skipping rotation
# resources at bootstrap is safe — they can be added once the Lambda is deployed.

resource "aws_secretsmanager_secret_rotation" "credential" {
  for_each = var.rotation_lambda_arn != "" ? local.rotatable_secrets : {}

  secret_id           = aws_secretsmanager_secret.credential[each.key].id
  rotation_lambda_arn = var.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = var.rotation_days
  }
}
