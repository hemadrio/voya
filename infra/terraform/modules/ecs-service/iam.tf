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

# Attach rds-db:connect policies when the service connects through RDS Proxy.
# Uses for_each over the list index to allow multiple policies (e.g. a service
# that connects as two users during a migration window).
resource "aws_iam_role_policy_attachment" "rds_connect" {
  for_each = {
    for idx, arn in var.rds_connect_policy_arns : tostring(idx) => arn
  }

  role       = aws_iam_role.task_role.name
  policy_arn = each.value
}

# ── Telemetry policy ─────────────────────────────────────────────────────────
# Least-privilege permissions for the ADOT collector sidecar running in the
# task. X-Ray actions require resources = ["*"] (AWS does not support
# resource-level restrictions on X-Ray write APIs). CloudWatch PutMetricData
# is further restricted by a namespace condition. Log writes are scoped to
# the service log group only.

data "aws_iam_policy_document" "telemetry" {
  statement {
    sid    = "XRayWrite"
    effect = "Allow"

    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]

    # X-Ray write APIs do not support resource-level restrictions.
    resources = ["*"]
  }

  statement {
    sid     = "CloudWatchMetricsWrite"
    effect  = "Allow"
    actions = ["cloudwatch:PutMetricData"]

    # CloudWatch PutMetricData does not accept resource ARNs, but the
    # namespace condition restricts writes to the platform namespace only.
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.cloudwatch_namespace]
    }
  }

  statement {
    sid    = "CloudWatchLogsWrite"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # Scoped to this service's log group; no cross-service log writes.
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${var.log_group_name}:*",
    ]
  }
}

resource "aws_iam_role_policy" "telemetry" {
  name   = "telemetry"
  role   = aws_iam_role.task_role.id
  policy = data.aws_iam_policy_document.telemetry.json
}

# ── SQS producer policy ───────────────────────────────────────────────────────
# Attached only to services that produce messages (booking, payment, ai-orchestration).
# Specific queue ARNs only — no wildcards (policy A01 least privilege).

data "aws_iam_policy_document" "sqs_producer" {
  count = length(var.sqs_producer_queue_arns) > 0 ? 1 : 0

  statement {
    sid    = "SQSProducer"
    effect = "Allow"

    actions = [
      "sqs:SendMessage",
      "sqs:GetQueueAttributes",
    ]

    resources = var.sqs_producer_queue_arns
  }
}

resource "aws_iam_role_policy" "sqs_producer" {
  count  = length(var.sqs_producer_queue_arns) > 0 ? 1 : 0
  name   = "sqs-producer"
  role   = aws_iam_role.task_role.id
  policy = data.aws_iam_policy_document.sqs_producer[0].json
}

# ── SQS consumer policy ───────────────────────────────────────────────────────
# Attached only to notification-consumer (and any future consumer services).
# Specific queue ARNs only — no wildcards.

data "aws_iam_policy_document" "sqs_consumer" {
  count = length(var.sqs_consumer_queue_arns) > 0 ? 1 : 0

  statement {
    sid    = "SQSConsumer"
    effect = "Allow"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]

    resources = var.sqs_consumer_queue_arns
  }
}

resource "aws_iam_role_policy" "sqs_consumer" {
  count  = length(var.sqs_consumer_queue_arns) > 0 ? 1 : 0
  name   = "sqs-consumer"
  role   = aws_iam_role.task_role.id
  policy = data.aws_iam_policy_document.sqs_consumer[0].json
}
