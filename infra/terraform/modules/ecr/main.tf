/**
 * ECR repositories — WO-085.
 *
 * One repository per service. Each repository is configured with:
 *   - IMMUTABLE tag mutability: pushing the same tag twice fails
 *   - scan_on_push: ECR native vulnerability scan on every push
 *   - Lifecycle policy: retain the 30 most recent tagged images
 *   - Repository policy: pull access limited to the ECS task execution roles;
 *     push access limited to the CI pipeline role
 *
 * Cosign signing is performed outside Terraform (in the push:sign pipeline
 * stage) using a KMS-backed key. This module only provisions the repositories.
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
  repos = toset(var.service_names)
}

# ── Repositories ──────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "service" {
  for_each = local.repos

  name                 = "${var.name_prefix}-${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  tags = merge(var.common_tags, {
    Service         = each.key
    Environment     = var.environment
    ManagedBy       = "terraform"
    SecurityControl = "WO-085"
  })
}

# ── Lifecycle policy — retain 30 most recent tagged images ────────────────────

resource "aws_ecr_lifecycle_policy" "service" {
  for_each   = local.repos
  repository = aws_ecr_repository.service[each.key].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Retain last 30 tagged images"
        selection = {
          tagStatus   = "tagged"
          tagPrefixList = [each.key]
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus = "untagged"
          countType = "sinceImagePushed"
          countUnit = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# ── Repository policy — restrict push to CI role, pull to task execution roles ─

resource "aws_ecr_repository_policy" "service" {
  for_each   = local.repos
  repository = aws_ecr_repository.service[each.key].name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCIPush"
        Effect = "Allow"
        Principal = {
          AWS = var.ci_role_arn
        }
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
      },
      {
        Sid    = "AllowECSPull"
        Effect = "Allow"
        Principal = {
          AWS = var.task_execution_role_arns
        }
        Action = [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchCheckLayerAvailability",
        ]
      },
      {
        Sid    = "DenyOtherPrincipals"
        Effect = "Deny"
        Principal = "*"
        Action = [
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
        ]
        Condition = {
          StringNotEquals = {
            "aws:PrincipalArn" = var.ci_role_arn
          }
        }
      }
    ]
  })
}
