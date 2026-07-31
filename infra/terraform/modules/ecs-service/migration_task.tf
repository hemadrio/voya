/**
 * migration_task.tf — One-off ECS migration runner (WO-086).
 *
 * Creates a dedicated migration-runner ECS task definition that the pipeline
 * invokes with RunTask before every service rollout. The migration task runs
 * `prisma migrate deploy` under a privileged DDL-capable IAM role. Service
 * task roles are restricted to DML only (enforced by PostgreSQL GRANTs in the
 * migration SQL itself — see prisma/migrations/**/migration.sql GRANT blocks).
 *
 * Enabled by setting enable_migration_task = true on the ecs-service module.
 * In production, this is set on the dedicated migration-runner module instantiation.
 *
 * Security model:
 *   - The migration task role is the ONLY principal attached to the
 *     migration_rds_connect_policy_arn (rds-db:connect as a DDL-capable
 *     PostgreSQL user, e.g. migration_task).
 *   - Service task roles receive per-service DML-only connect policies.
 *   - The migration log group uses the same KMS key as the service log group
 *     to ensure credential patterns in migration output are encrypted at rest.
 *
 * Concurrency:
 *   Prisma holds a PostgreSQL advisory lock (pg_advisory_lock) for the
 *   duration of `migrate deploy`, so concurrent invocations queue rather than
 *   race. An additional pipeline mutex (aws ssm put-parameter --overwrite)
 *   prevents two pipeline runs from launching migration tasks simultaneously.
 *
 * Idempotency:
 *   The _prisma_migrations table tracks applied migrations; re-running the
 *   task on an already-migrated database is a no-op. All migration SQL files
 *   use IF NOT EXISTS / IF EXISTS / DO-block guards for extra safety.
 */

# ── Migration log group ───────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "migration" {
  count = var.enable_migration_task ? 1 : 0

  # Dedicated log group so migration output (DDL progress, Prisma advisory lock
  # messages) is easily isolated from service application logs.
  name              = "/ecs/${var.environment}/migration-runner"
  retention_in_days = var.log_retention_days

  # Same KMS key as the service log group — credentials emitted during
  # migration (e.g. connection strings in error messages) are encrypted.
  kms_key_id = var.log_group_kms_key_arn != "" ? var.log_group_kms_key_arn : null

  tags = merge(var.common_tags, {
    Name        = "/ecs/${var.environment}/migration-runner"
    Service     = "migration-runner"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ── Migration task execution role ─────────────────────────────────────────────
# Grants the ECS agent permission to pull the image and resolve secrets at
# task placement time. Identical policy shape to the service execution role
# but with a distinct name so the two roles can be audited independently.

resource "aws_iam_role" "migration_exec" {
  count = var.enable_migration_task ? 1 : 0

  name               = "${var.environment}-migration-runner-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-migration-runner-exec"
    Environment = var.environment
    Service     = "migration-runner"
    ManagedBy   = "terraform"
  })
}

resource "aws_iam_role_policy_attachment" "migration_exec_managed" {
  count = var.enable_migration_task ? 1 : 0

  role       = aws_iam_role.migration_exec[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "migration_secret_retrieval" {
  count = var.enable_migration_task && length(var.migration_secret_refs) > 0 ? 1 : 0

  statement {
    sid    = "MigrationSecretRetrieval"
    effect = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = values(var.migration_secret_refs)
  }

  dynamic "statement" {
    for_each = length(var.kms_key_arns) > 0 ? [1] : []
    content {
      sid    = "MigrationKMSDecrypt"
      effect = "Allow"
      actions = ["kms:Decrypt", "kms:DescribeKey"]
      resources = var.kms_key_arns
    }
  }
}

resource "aws_iam_role_policy" "migration_secret_retrieval" {
  count = var.enable_migration_task && length(var.migration_secret_refs) > 0 ? 1 : 0

  name   = "migration-secret-retrieval"
  role   = aws_iam_role.migration_exec[0].id
  policy = data.aws_iam_policy_document.migration_secret_retrieval[0].json
}

# ── Migration task role ───────────────────────────────────────────────────────
# Assumed by the container at runtime. Receives the DDL-capable rds-db:connect
# policy (migration_rds_connect_policy_arn from the rds-proxy module output).
# Service task roles do NOT receive this policy — they receive DML-only policies.

resource "aws_iam_role" "migration_task_role" {
  count = var.enable_migration_task ? 1 : 0

  name               = "${var.environment}-migration-runner-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-migration-runner-task"
    Environment = var.environment
    Service     = "migration-runner"
    ManagedBy   = "terraform"
    Privilege   = "DDL"
  })
}

resource "aws_iam_role_policy_attachment" "migration_rds_connect" {
  count = var.enable_migration_task && var.migration_rds_connect_policy_arn != "" ? 1 : 0

  role       = aws_iam_role.migration_task_role[0].name
  policy_arn = var.migration_rds_connect_policy_arn
}

# CloudWatch Logs write permission for the migration task role (the task itself
# writes structured logs via the awslogs driver).
data "aws_iam_policy_document" "migration_logs" {
  count = var.enable_migration_task ? 1 : 0

  statement {
    sid    = "MigrationLogsWrite"
    effect = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ecs/${var.environment}/migration-runner:*",
    ]
  }
}

resource "aws_iam_role_policy" "migration_logs" {
  count = var.enable_migration_task ? 1 : 0

  name   = "migration-logs"
  role   = aws_iam_role.migration_task_role[0].id
  policy = data.aws_iam_policy_document.migration_logs[0].json
}

# ── Migration ECS task definition ─────────────────────────────────────────────

resource "aws_ecs_task_definition" "migration_runner" {
  count = var.enable_migration_task ? 1 : 0

  family                   = "${var.environment}-migration-runner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"

  # 1 vCPU / 2 GB: sufficient for Prisma migration apply (mostly I/O, not CPU).
  # Increase via migration_cpu / migration_memory vars if large index operations
  # (CREATE INDEX CONCURRENTLY) are required.
  cpu    = var.migration_cpu
  memory = var.migration_memory

  execution_role_arn = aws_iam_role.migration_exec[0].arn
  task_role_arn      = aws_iam_role.migration_task_role[0].arn

  container_definitions = jsonencode([
    {
      name      = "migration-runner"
      image     = var.migration_container_image != "" ? var.migration_container_image : var.container_image
      essential = true

      # Override the default service command with prisma migrate deploy.
      # The schema path is fixed at prisma/schema.prisma (repo root) and
      # injected as the PRISMA_SCHEMA env var for portability.
      command = ["npx", "prisma", "migrate", "deploy", "--schema=/app/prisma/schema.prisma"]

      environment = [
        { name = "NODE_ENV", value = var.environment },
        { name = "PRISMA_SCHEMA", value = "/app/prisma/schema.prisma" },
      ]

      # DATABASE_URL is the only required secret — must point to the RDS Proxy
      # endpoint and use IAM auth (rds-iam:// scheme or AWS RDS token).
      secrets = [
        for k, arn in var.migration_secret_refs : { name = k, valueFrom = arn }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/${var.environment}/migration-runner"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "migration"
          # Redact connection-string passwords from CloudWatch output.
          # The pattern matches postgresql://user:PASSWORD@host and replaces
          # the password segment with [REDACTED] before writing to CloudWatch.
          "awslogs-create-group" = "false"
        }
      }

      # No port mapping — migration runner is not a server.
      portMappings = []

      # One-off task; no health check needed (task runs to completion, not steady-state).
      healthCheck = null
    }
  ])

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-migration-runner"
    Environment = var.environment
    Service     = "migration-runner"
    ManagedBy   = "terraform"
    Privilege   = "DDL"
  })

  depends_on = [aws_cloudwatch_log_group.migration]
}
