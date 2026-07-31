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
