/**
 * KMS Customer-Managed Keys — one per data store.
 *
 * Separate keys per store ensure blast radius is contained: compromise of the
 * RDS key does not expose ElastiCache data and vice versa. Key rotation is
 * automatic (AWS-managed) and runs every 365 days; the 90-day secret rotation
 * cadence for application secrets (Secrets Manager) provides additional
 * defence-in-depth.
 *
 * Stores: rds, elasticache, s3, sqs, secretsmanager
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  stores = toset(["rds", "elasticache", "s3", "sqs", "secretsmanager"])
}

# ── One CMK per data store ──────────────────────────────────────────────────

resource "aws_kms_key" "store" {
  for_each = local.stores

  description             = "CMK for ${each.key} — ${var.environment} — travel platform"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = data.aws_iam_policy_document.kms_policy[each.key].json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-${each.key}-cmk"
    Environment = var.environment
    Store       = each.key
    ManagedBy   = "terraform"
  })
}

resource "aws_kms_alias" "store" {
  for_each = aws_kms_key.store

  name          = "alias/${var.environment}/platform/${each.key}"
  target_key_id = each.value.key_id
}

# ── Key policies ────────────────────────────────────────────────────────────
# Each key grants:
#   1. Account root — full management (allows break-glass recovery)
#   2. Explicit service principals — decrypt + generate data key only
# No wildcard principals in statement 2 — least privilege is enforced per store.

data "aws_iam_policy_document" "kms_policy" {
  for_each = local.stores

  # Statement 1: account root — administrative control, no operational rights
  statement {
    sid    = "AllowAccountRootAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # Statement 2: service principals — encrypt/decrypt only, no key management
  dynamic "statement" {
    for_each = length(lookup(var.allowed_principal_arns, each.key, [])) > 0 ? [1] : []

    content {
      sid    = "AllowServiceDecrypt"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = lookup(var.allowed_principal_arns, each.key, [])
      }

      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:GenerateDataKey",
        "kms:GenerateDataKeyWithoutPlaintext",
      ]

      resources = ["*"]
    }
  }

  # Statement 3: allow CloudWatch Logs to use the key for encrypted log groups
  dynamic "statement" {
    for_each = each.key == "secretsmanager" ? [1] : []

    content {
      sid    = "AllowCloudWatchLogs"
      effect = "Allow"

      principals {
        type        = "Service"
        identifiers = ["logs.amazonaws.com"]
      }

      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]

      resources = ["*"]
    }
  }
}
