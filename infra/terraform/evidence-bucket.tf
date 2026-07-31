/**
 * evidence-bucket.tf — S3 evidence bucket for SOC 2 continuous evidence collection.
 *
 * Properties:
 *   - Object Lock in compliance mode (WORM — no overwrite or delete)
 *   - Default retention period matches the audit retention requirement (365 days)
 *   - Versioning enabled (required by Object Lock)
 *   - KMS encryption with a dedicated evidence CMK
 *   - Blocked public access (all four settings)
 *   - Server access logging to a separate access-log bucket
 *
 * Collector IAM role is granted PutObject only — no DeleteObject, no
 * PutObjectRetention on existing objects (least-privilege, AC2 constraint).
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
# Variables
# ---------------------------------------------------------------------------

variable "evidence_retention_days" {
  description = "Object Lock default retention in days. Must be >= audit retention requirement (365)."
  type        = number
  default     = 365

  validation {
    condition     = var.evidence_retention_days >= 365
    error_message = "Evidence retention must be at least 365 days to satisfy audit requirements."
  }
}

variable "evidence_bucket_access_log_bucket" {
  description = "Name of the S3 bucket to receive evidence bucket access logs."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# KMS key — dedicated evidence CMK
# ---------------------------------------------------------------------------

resource "aws_kms_key" "evidence" {
  description             = "${var.environment} evidence bucket CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AccountRootAdmin"
        Effect = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "CollectorEncrypt"
        Effect = "Allow"
        Principal = { AWS = aws_iam_role.evidence_collector_task.arn }
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = "*"
      }
    ]
  })

  tags = merge(local.common_tags, {
    Name    = "${var.environment}-evidence-cmk"
    Purpose = "soc2-evidence-encryption"
  })
}

resource "aws_kms_alias" "evidence" {
  name          = "alias/${var.environment}-evidence"
  target_key_id = aws_kms_key.evidence.key_id
}

# ---------------------------------------------------------------------------
# S3 bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "evidence" {
  bucket        = "${var.environment}-travel-compliance-evidence"
  force_destroy = false   # safety: prevent accidental deletion in CI

  object_lock_enabled = true

  tags = merge(local.common_tags, {
    Name    = "${var.environment}-compliance-evidence"
    Purpose = "soc2-evidence"
  })
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.evidence_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.evidence.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter { prefix = "" }

    noncurrent_version_expiration {
      # Object Lock prevents deletion of current versions; this cleans up
      # non-current versions after 30 extra days beyond the retention period.
      noncurrent_days = var.evidence_retention_days + 30
    }
  }
}

resource "aws_s3_bucket_logging" "evidence" {
  count  = var.evidence_bucket_access_log_bucket != "" ? 1 : 0
  bucket = aws_s3_bucket.evidence.id

  target_bucket = var.evidence_bucket_access_log_bucket
  target_prefix = "evidence-bucket-access-logs/"
}

# ---------------------------------------------------------------------------
# IAM — collector task role (PutObject only, scoped to bucket)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "evidence_collector_task" {
  name = "${var.environment}-evidence-collector-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "evidence_collector_s3" {
  name = "evidence-bucket-put"
  role = aws_iam_role.evidence_collector_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PutEvidenceArtefacts"
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.evidence.arn}/*"
        # Explicitly deny delete and retention mutation to enforce least-privilege
      },
      {
        Sid    = "DenyDestructiveActions"
        Effect = "Deny"
        Action = [
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:PutObjectRetention",
          "s3:BypassGovernanceRetention",
        ]
        Resource = "${aws_s3_bucket.evidence.arn}/*"
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "evidence_bucket_name" {
  value       = aws_s3_bucket.evidence.bucket
  description = "Name of the SOC 2 evidence S3 bucket."
}

output "evidence_bucket_arn" {
  value       = aws_s3_bucket.evidence.arn
  description = "ARN of the SOC 2 evidence S3 bucket."
}

output "evidence_kms_key_arn" {
  value       = aws_kms_key.evidence.arn
  description = "ARN of the evidence bucket KMS CMK."
}

output "evidence_collector_task_role_arn" {
  value       = aws_iam_role.evidence_collector_task.arn
  description = "ARN of the evidence collector ECS task role."
}
