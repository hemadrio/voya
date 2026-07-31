/**
 * Retention Purge Worker — ECS Scheduled Task (EventBridge-triggered).
 *
 * Runs once daily (default 02:00 UTC). The task is NOT a long-running service:
 * it runs, purges expired rows, and exits. Exit code non-zero → CloudWatch alarm.
 *
 * IAM: least-privilege task role.
 *   - db: purge_worker role (scoped GRANTs defined in migration 0010)
 *   - KMS: decrypt only on the purge DEK key
 *   - No S3, no SQS, no broad IAM permissions
 *
 * Dry-run is the default. Override command to ["node", "dist/index.js", "--apply"]
 * in the EventBridge target input transformer for live purges.
 */

# ---------------------------------------------------------------------------
# IAM — Task Execution Role (ECR pull + Secrets Manager read)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "retention_worker_execution" {
  name = "${var.environment}-retention-worker-execution-role"

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

resource "aws_iam_role_policy_attachment" "retention_worker_execution_policy" {
  role       = aws_iam_role.retention_worker_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "retention_worker_secrets" {
  name = "secrets-read"
  role = aws_iam_role.retention_worker_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [
        var.database_url_secret_arn,
        var.redis_url_secret_arn,
      ]
    }]
  })
}

# ---------------------------------------------------------------------------
# IAM — Task Role (runtime permissions — least-privilege)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "retention_worker_task" {
  name = "${var.environment}-retention-worker-task-role"

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

# KMS: decrypt only — needed to unwrap DEKs before nullification
resource "aws_iam_role_policy" "retention_worker_kms" {
  name = "kms-decrypt"
  role = aws_iam_role.retention_worker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:DescribeKey"]
      Resource = [var.purge_kms_key_arn]
    }]
  })
}

# CloudWatch Logs: write only — no read access
resource "aws_iam_role_policy" "retention_worker_logs" {
  name = "cloudwatch-logs"
  role = aws_iam_role.retention_worker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = "${aws_cloudwatch_log_group.retention_worker.arn}:*"
    }]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "retention_worker" {
  name              = "/ecs/${var.environment}/retention-worker"
  retention_in_days = 90
  kms_key_id        = var.logs_kms_key_arn

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ECS Task Definition (Fargate, no long-running service)
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "retention_worker" {
  family                   = "${var.environment}-retention-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.retention_worker_execution.arn
  task_role_arn            = aws_iam_role.retention_worker_task.arn

  container_definitions = jsonencode([{
    name      = "retention-worker"
    image     = var.retention_worker_image
    essential = true

    # Default: dry-run. EventBridge input transformer overrides with --apply for live purges.
    command = ["node", "dist/index.js"]

    environment = [
      { name = "NODE_ENV",                         value = var.environment },
      { name = "PURGE_BATCH_SIZE",                 value = "500" },
      { name = "PURGE_INTER_BATCH_PAUSE_MS",       value = "250" },
      { name = "PURGE_MAX_BATCHES_PER_CATEGORY",   value = "1000" },
      { name = "PURGE_LOAD_THRESHOLD",             value = "0.7" },
      { name = "PURGE_LEASE_TTL_SECONDS",          value = "3600" },
      { name = "KMS_PURGE_KEY_ARN",                value = var.purge_kms_key_arn },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
      { name = "REDIS_URL",    valueFrom = var.redis_url_secret_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.retention_worker.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# EventBridge IAM — allow EventBridge to run ECS tasks
# ---------------------------------------------------------------------------

resource "aws_iam_role" "eventbridge_retention_worker" {
  name = "${var.environment}-eventbridge-retention-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "eventbridge_retention_worker_ecs" {
  name = "run-ecs-task"
  role = aws_iam_role.eventbridge_retention_worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = aws_ecs_task_definition.retention_worker.arn
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [
          aws_iam_role.retention_worker_execution.arn,
          aws_iam_role.retention_worker_task.arn,
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# EventBridge Scheduler — daily at 02:00 UTC
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule" "retention_worker_daily" {
  name                         = "${var.environment}-retention-worker-daily"
  description                  = "Runs the retention purge worker daily at 02:00 UTC"
  schedule_expression          = "cron(0 2 * * ? *)"
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 30
  }

  target {
    arn      = var.ecs_cluster_arn
    role_arn = aws_iam_role.eventbridge_retention_worker.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.retention_worker.arn
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [aws_security_group.retention_worker.id]
        assign_public_ip = false
      }

      # --apply flag activates live purge; omit for dry-run (default)
      # Override input transformer here or leave as-is for scheduled dry-runs.
    }
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Security Group — egress to RDS proxy and Redis; no inbound
# ---------------------------------------------------------------------------

resource "aws_security_group" "retention_worker" {
  name        = "${var.environment}-retention-worker-sg"
  description = "Retention purge worker — egress to DB and Redis only"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    description = "PostgreSQL via RDS Proxy"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    description = "Redis"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    description = "HTTPS — KMS, CloudWatch Logs, Secrets Manager"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.environment}-retention-worker-sg" })
}

# ---------------------------------------------------------------------------
# Variables used by this file (declared here if not already declared)
# ---------------------------------------------------------------------------

variable "retention_worker_image" {
  description = "Docker image URI for the retention worker (ECR)"
  type        = string
}

variable "purge_kms_key_arn" {
  description = "KMS key ARN used for DEK encryption in the purge worker"
  type        = string
}
