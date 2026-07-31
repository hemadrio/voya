/**
 * IAM roles for ECS tasks.
 *
 * task_execution_role — assumed by the ECS agent at task placement. Grants
 *   secretsmanager:GetSecretValue scoped to exactly the secret ARNs the service
 *   requires (no wildcards), plus kms:Decrypt on the corresponding CMKs.
 *
 * task_role — assumed by application code inside the running container. Starts
 *   empty; services attach additional policies via their own Terraform.
 */

data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    sid    = "AllowECSTasksAssumeRole"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

# ── Task execution role ──────────────────────────────────────────────────────

resource "aws_iam_role" "task_execution" {
  name               = "${var.environment}-${var.service_name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-${var.service_name}-exec"
    Environment = var.environment
    Service     = var.service_name
    ManagedBy   = "terraform"
  })
}

# Managed policy for ECR image pull and CloudWatch Logs writing — AWS-managed,
# not scoped further because ECR/Logs don't contain customer data.
resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Inline policy: least-privilege secret retrieval.
# secretsmanager:GetSecretValue is scoped to explicit ARNs derived from
# var.secret_refs so a service cannot read another service's secrets.
data "aws_iam_policy_document" "secret_retrieval" {
  dynamic "statement" {
    for_each = length(var.secret_refs) > 0 ? [1] : []

    content {
      sid    = "AllowSecretRetrieval"
      effect = "Allow"

      actions = ["secretsmanager:GetSecretValue"]

      # Explicit ARN list — no wildcards. Adding a new secret requires a
      # Terraform change so there is an auditable change-control record.
      resources = values(var.secret_refs)
    }
  }

  dynamic "statement" {
    for_each = length(var.kms_key_arns) > 0 ? [1] : []

    content {
      sid    = "AllowKMSDecryptForSecrets"
      effect = "Allow"

      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
      ]

      resources = var.kms_key_arns
    }
  }
}

resource "aws_iam_role_policy" "secret_retrieval" {
  name   = "secret-retrieval"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.secret_retrieval.json
}

# ── Task role ────────────────────────────────────────────────────────────────

resource "aws_iam_role" "task_role" {
  name               = "${var.environment}-${var.service_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-${var.service_name}-task"
    Environment = var.environment
    Service     = var.service_name
    ManagedBy   = "terraform"
  })
}
