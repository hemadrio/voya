/**
 * kms.tf — Traveler identity CMK for KMS envelope encryption (WO-073).
 *
 * Key design:
 *   - One CMK per environment (dev/staging/production) scoped to traveler identity.
 *   - Rotation enabled: AWS auto-rotates annually; old key material is retained
 *     so existing wrapped DEKs decrypt correctly (dek_key_id tracks which CMK
 *     generation wrapped each DEK).
 *   - Three explicit IAM statements:
 *       1. Account root — break-glass key administration only
 *       2. booking-service task role — Encrypt + GenerateDataKey + Decrypt
 *          (the only service permitted to decrypt identity documents)
 *       3. backfill task role — Encrypt + GenerateDataKey only
 *          (backfill may encrypt but must NOT decrypt; Decrypt is excluded)
 *   - No wildcard GenerateDataKey grant; the backfill role is explicitly denied
 *     Decrypt to enforce least privilege (AC9, constraint: only booking service
 *     may hold Decrypt).
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Data sources — resolve task role ARNs from SSM or locals
# ---------------------------------------------------------------------------

variable "booking_service_task_role_arn" {
  type        = string
  description = "IAM role ARN for the booking-service ECS task. Granted Decrypt + GenerateDataKey."
}

variable "backfill_task_role_arn" {
  type        = string
  description = "IAM role ARN for the backfill/migration ECS task. Granted Encrypt + GenerateDataKey only."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev | staging | production)."
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID for the key policy root principal."
}

variable "common_tags" {
  type        = map(string)
  description = "Common resource tags."
  default     = {}
}

# ---------------------------------------------------------------------------
# Traveler identity CMK key policy
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "traveler_identity_kms_policy" {
  # Statement 1: account root — administrative control (break-glass)
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

  # Statement 2: booking-service — encrypt + decrypt + generate data key
  # This is the ONLY service permitted to decrypt traveler identity documents.
  statement {
    sid    = "AllowBookingServiceEncryptDecrypt"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [var.booking_service_task_role_arn]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:DescribeKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]

    resources = ["*"]
  }

  # Statement 3: backfill task — encrypt + generate data key ONLY
  # Explicit Decrypt DENY is added in statement 4 as defence-in-depth.
  statement {
    sid    = "AllowBackfillEncryptAndGenerate"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [var.backfill_task_role_arn]
    }

    actions = [
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:DescribeKey",
    ]

    resources = ["*"]
  }

  # Statement 4: explicit Decrypt DENY for backfill (defence-in-depth)
  # IAM deny takes precedence over any allow — this survives accidental
  # IAM policy changes that might otherwise grant Decrypt.
  statement {
    sid    = "DenyBackfillDecrypt"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = [var.backfill_task_role_arn]
    }

    actions   = ["kms:Decrypt"]
    resources = ["*"]
  }
}

# ---------------------------------------------------------------------------
# Traveler identity CMK
# ---------------------------------------------------------------------------

resource "aws_kms_key" "traveler_identity" {
  description             = "Traveler identity documents DEK wrapping key — ${var.environment}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = data.aws_iam_policy_document.traveler_identity_kms_policy.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-traveler-identity-cmk"
    Environment = var.environment
    Purpose     = "traveler-identity-envelope-encryption"
    ManagedBy   = "terraform"
    Compliance  = "pii-restricted"
  })
}

resource "aws_kms_alias" "traveler_identity" {
  name          = "alias/${var.environment}/platform/traveler-identity"
  target_key_id = aws_kms_key.traveler_identity.key_id
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "traveler_identity_cmk_arn" {
  description = "ARN of the traveler identity CMK. Set as CMK_ARN in the booking service and backfill task."
  value       = aws_kms_key.traveler_identity.arn
}

output "traveler_identity_cmk_key_id" {
  description = "Key ID of the traveler identity CMK."
  value       = aws_kms_key.traveler_identity.key_id
}

output "traveler_identity_cmk_alias_arn" {
  description = "Alias ARN for the traveler identity CMK."
  value       = aws_kms_alias.traveler_identity.arn
}
