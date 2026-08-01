/**
 * s3-documents.tf — S3 bucket for generated trip document PDFs (WO-054).
 *
 * Properties:
 *   - KMS-SSE with a dedicated documents CMK (not shared with identity data)
 *   - Object lifecycle: transition to Glacier after 30 days, expire after 90 days
 *     (aligned to the trip_document.purge_after retention column)
 *   - Public access blocked on all four settings
 *   - No object lock (documents are mutable — status can change from PENDING→READY)
 *   - Versioning disabled (PDFs are write-once under a content-addressed key)
 *
 * Access model:
 *   booking-service task role: PutObject + GetObject + DeleteObject
 *   (DeleteObject for purge worker; pre-signed URLs use the task role credentials)
 *
 * CloudWatch metrics:
 *   - NumberOfDocumentsGenerated: success count (emitted by booking-service)
 *   - DocumentGenerationDuration: p99 render latency (emitted by booking-service)
 *   - DocumentGenerationFailures: failure count — alarm threshold 1 in 5 min
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

variable "documents_bucket_retention_days" {
  description = "Days after generation before trip document PDFs are expired. Must match trip_document.purge_after logic."
  type        = number
  default     = 90

  validation {
    condition     = var.documents_bucket_retention_days >= 30
    error_message = "Document retention must be at least 30 days."
  }
}

variable "documents_bucket_glacier_transition_days" {
  description = "Days after creation before objects transition to Glacier Instant Retrieval."
  type        = number
  default     = 30
}

variable "booking_service_documents_task_role_arn" {
  type        = string
  description = "IAM role ARN for the booking-service ECS task. Granted PutObject + GetObject + DeleteObject."
}

# ---------------------------------------------------------------------------
# KMS key — dedicated documents CMK
#
# Separate from the traveler identity CMK (kms.tf) — principle of least privilege:
# a key compromise of the identity CMK must not expose document content, and vice versa.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "documents" {
  description             = "${var.environment} trip documents CMK"
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
        Sid    = "BookingServiceEncryptDecrypt"
        Effect = "Allow"
        Principal = { AWS = var.booking_service_documents_task_role_arn }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = "*"
      }
    ]
  })

  tags = merge(local.common_tags, {
    Name    = "${var.environment}-documents-cmk"
    Purpose = "trip-document-encryption"
  })
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${var.environment}-documents"
  target_key_id = aws_kms_key.documents.key_id
}

# ---------------------------------------------------------------------------
# S3 bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "documents" {
  bucket        = "${var.environment}-travel-trip-documents"
  force_destroy = false

  tags = merge(local.common_tags, {
    Name    = "${var.environment}-trip-documents"
    Purpose = "trip-document-storage"
  })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.documents.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "transition-and-expire-documents"
    status = "Enabled"

    filter { prefix = "" }

    transition {
      days          = var.documents_bucket_glacier_transition_days
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = var.documents_bucket_retention_days
    }
  }
}

# ---------------------------------------------------------------------------
# IAM — booking-service task role access
# ---------------------------------------------------------------------------

resource "aws_iam_role_policy" "booking_service_documents_s3" {
  name = "trip-documents-s3"
  role = split("/", var.booking_service_documents_task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadWriteDocuments"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.documents.arn}/*"
      },
      {
        Sid      = "ListBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.documents.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch — generation metrics and failure alarm
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "document_generation_failure" {
  name           = "${var.environment}-document-generation-failure"
  pattern        = "{ $.event = \"DOCUMENT_GENERATION_FAILED\" }"
  log_group_name = "/ecs/${var.environment}/booking-service"

  metric_transformation {
    name          = "DocumentGenerationFailures"
    namespace     = "TravelPlatform/${var.environment}/BookingService"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "document_generation_failure" {
  alarm_name          = "${var.environment}-document-generation-failure"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "DocumentGenerationFailures"
  namespace           = "TravelPlatform/${var.environment}/BookingService"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Any trip document generation failure in the last 5 minutes"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "documents_bucket_name" {
  value       = aws_s3_bucket.documents.bucket
  description = "Name of the trip documents S3 bucket."
}

output "documents_bucket_arn" {
  value       = aws_s3_bucket.documents.arn
  description = "ARN of the trip documents S3 bucket."
}

output "documents_kms_key_arn" {
  value       = aws_kms_key.documents.arn
  description = "ARN of the documents bucket KMS CMK."
}
