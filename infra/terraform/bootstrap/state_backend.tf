/**
 * Bootstrap stack — remote state backend.
 *
 * Provisions the S3 bucket (versioning + SSE-KMS + public-access block) and
 * DynamoDB lock table that all environment root stacks use for remote state.
 *
 * IMPORTANT: This stack uses LOCAL state intentionally — it cannot use the S3
 * backend it is about to create. Run it once per environment before the first
 * `terraform init` of the corresponding environment root stack:
 *
 *   cd infra/terraform/bootstrap
 *   terraform init
 *   terraform apply -var="environment=dev"
 *   terraform apply -var="environment=staging"
 *   terraform apply -var="environment=production"
 *
 * The stack is idempotent and safe to re-run. State locking for two concurrent
 * applies is verified by running two applies concurrently — the second fails with
 * "Error acquiring the state lock".
 *
 * The terraform.tfstate produced by this stack should be committed to a
 * separate private repository or stored in a manually managed S3 bucket in the
 * ops account (not in the bucket being bootstrapped).
 */

terraform {
  required_version = "~> 1.15"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # No backend block — this stack uses local state.
}

variable "environment" {
  type        = string
  description = "Target environment (dev | staging | production). Determines bucket and table names."

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be 'dev', 'staging', or 'production'."
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region for the state bucket and lock table."
  default     = "eu-west-1"
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Service            = "travel-platform"
      Environment        = var.environment
      CostCentre         = "platform"
      Owner              = "platform-team"
      DataClassification = var.environment == "production" ? "Confidential" : "Synthetic"
      ManagedBy          = "terraform"
    }
  }
}

locals {
  state_bucket_name = "travel-platform-tfstate-${var.environment}"
  lock_table_name   = "travel-platform-tfstate-lock-${var.environment}"
}

# S3 bucket — versioning + SSE-KMS + all public access blocked
resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket_name

  # Prevent accidental deletion of the state bucket.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = local.state_bucket_name
    Purpose = "terraform-state"
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# DynamoDB lock table — on-demand billing, LockID hash key required by Terraform
resource "aws_dynamodb_table" "tfstate_lock" {
  name         = local.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name    = local.lock_table_name
    Purpose = "terraform-state-lock"
  }
}

output "state_bucket_name" {
  description = "S3 bucket name for Terraform state."
  value       = aws_s3_bucket.tfstate.id
}

output "lock_table_name" {
  description = "DynamoDB table name for state locking."
  value       = aws_dynamodb_table.tfstate_lock.id
}

output "backend_config" {
  description = "Partial backend config snippet — paste into the environment backend.tf backend block."
  value = <<-EOT
    bucket         = "${local.state_bucket_name}"
    key            = "${var.environment}/terraform.tfstate"
    region         = "${var.aws_region}"
    encrypt        = true
    dynamodb_table = "${local.lock_table_name}"
  EOT
}
