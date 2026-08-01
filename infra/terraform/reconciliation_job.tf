# reconciliation_job.tf — Daily payment-to-booking reconciliation ECS task (WO-050).
#
# Architecture:
#   EventBridge Scheduler (cron 02:00 UTC daily)
#     → ECS RunTask (Fargate, one-shot, no long-running service)
#       → payment-service image, command: node dist/jobs/reconciliation.js
#
# The task reads Stripe balance transactions for the prior day, compares them
# against the payments ledger and booking states, persists classified exceptions,
# emits CloudWatch metrics, and writes an encrypted S3 report.
#
# Alarms (AC4):
#   1. CRITICAL — any non-zero ReconciliationExceptions in a completed run.
#   2. CRITICAL — no completed run in 26 hours (missed-run / task failure).
#
# IAM:
#   execution role : ECR pull + Secrets Manager (DATABASE_URL, STRIPE_SECRET_KEY)
#   task role      : CloudWatch Logs, S3 report bucket write, KMS for SSE,
#                    Stripe API read-only (no write capabilities)

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "reconciliation_job_image" {
  description = "Docker image URI for the reconciliation job (same image as payment-service)"
  type        = string
}

variable "reconciliation_s3_bucket" {
  description = "S3 bucket name for reconciliation report artifacts"
  type        = string
  default     = ""
}

variable "reconciliation_s3_bucket_arn" {
  description = "ARN of the S3 bucket for reconciliation report artifacts"
  type        = string
  default     = ""
}

variable "stripe_secret_key_arn" {
  description = "Secrets Manager ARN for the Stripe restricted API key (read-only balance transactions)"
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# IAM — Execution Role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "reconciliation_job_execution" {
  name = "${var.environment}-reconciliation-job-execution-role"

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

resource "aws_iam_role_policy_attachment" "reconciliation_job_execution_policy" {
  role       = aws_iam_role.reconciliation_job_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "reconciliation_job_secrets" {
  name = "secrets-read"
  role = aws_iam_role.reconciliation_job_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = compact([var.database_url_secret_arn, var.stripe_secret_key_arn])
    }]
  })
}

# ---------------------------------------------------------------------------
# IAM — Task Role (least-privilege runtime)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "reconciliation_job_task" {
  name = "${var.environment}-reconciliation-job-task-role"

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

resource "aws_iam_role_policy" "reconciliation_job_logs" {
  name = "cloudwatch-logs"
  role = aws_iam_role.reconciliation_job_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = "${aws_cloudwatch_log_group.reconciliation_job.arn}:*"
    }]
  })
}

resource "aws_iam_role_policy" "reconciliation_job_cloudwatch_metrics" {
  name = "cloudwatch-metrics"
  role = aws_iam_role.reconciliation_job_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cloudwatch:PutMetricData"]
      Resource = "*"
      Condition = {
        StringEquals = {
          "cloudwatch:namespace" = "travel/payment"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "reconciliation_job_s3" {
  name = "s3-report-write"
  role = aws_iam_role.reconciliation_job_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${var.reconciliation_s3_bucket_arn}/reconciliation/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = var.kms_key_arn
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "reconciliation_job" {
  name              = "/ecs/${var.environment}/reconciliation-job"
  retention_in_days = 90
  kms_key_id        = var.logs_kms_key_arn

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ECS Task Definition (Fargate, one-shot)
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "reconciliation_job" {
  family                   = "${var.environment}-reconciliation-job"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.reconciliation_job_execution.arn
  task_role_arn            = aws_iam_role.reconciliation_job_task.arn

  container_definitions = jsonencode([{
    name      = "reconciliation-job"
    image     = var.reconciliation_job_image
    essential = true

    command = ["node", "dist/jobs/reconciliation.js"]

    environment = [
      { name = "NODE_ENV",                       value = var.environment },
      { name = "RECONCILIATION_S3_BUCKET",       value = var.reconciliation_s3_bucket },
      { name = "AWS_REGION",                     value = var.aws_region },
      { name = "RECONCILIATION_PAGE_SIZE",       value = "100" },
    ]

    secrets = [
      { name = "DATABASE_URL",         valueFrom = var.database_url_secret_arn },
      { name = "STRIPE_SECRET_KEY",    valueFrom = var.stripe_secret_key_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.reconciliation_job.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Security Group — egress to RDS Proxy, Stripe API, and S3/CloudWatch only
# ---------------------------------------------------------------------------

resource "aws_security_group" "reconciliation_job" {
  name        = "${var.environment}-reconciliation-job-sg"
  description = "Reconciliation job — egress to DB proxy, Stripe API (HTTPS), and AWS services"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    description = "PostgreSQL via RDS Proxy"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    description = "HTTPS — Stripe API, S3, CloudWatch Logs, Secrets Manager"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.environment}-reconciliation-job-sg" })
}

# ---------------------------------------------------------------------------
# EventBridge IAM — scheduler role to run ECS tasks
# ---------------------------------------------------------------------------

resource "aws_iam_role" "eventbridge_reconciliation_job" {
  name = "${var.environment}-eventbridge-reconciliation-job-role"

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

resource "aws_iam_role_policy" "eventbridge_reconciliation_job_ecs" {
  name = "run-ecs-task"
  role = aws_iam_role.eventbridge_reconciliation_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = aws_ecs_task_definition.reconciliation_job.arn
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [
          aws_iam_role.reconciliation_job_execution.arn,
          aws_iam_role.reconciliation_job_task.arn,
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# EventBridge Scheduler — daily at 02:00 UTC
# (Previous day settlement window closes by 01:00 UTC for most payment networks)
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule" "reconciliation_job" {
  name                         = "${var.environment}-reconciliation-job"
  description                  = "Daily payment-to-booking reconciliation at 02:00 UTC"
  schedule_expression          = "cron(0 2 * * ? *)"
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.ecs_cluster_arn
    role_arn = aws_iam_role.eventbridge_reconciliation_job.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.reconciliation_job.arn
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [aws_security_group.reconciliation_job.id]
        assign_public_ip = false
      }
    }
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# CloudWatch Metric Filters + Alarms (AC4)
# ---------------------------------------------------------------------------

locals {
  reconciliation_namespace = "travel/payment"
}

# Filter: emit metric on completed reconciliation exception count > 0
resource "aws_cloudwatch_log_metric_filter" "reconciliation_exceptions" {
  name           = "reconciliation-exceptions-nonzero"
  log_group_name = aws_cloudwatch_log_group.reconciliation_job.name
  # Match the structured log from runReconciliationJob: exceptionCount > 0 at COMPLETED
  pattern        = "{ $.msg = \"Reconciliation job completed\" && $.exceptionCount > 0 }"

  metric_transformation {
    name          = "ReconciliationExceptions"
    namespace     = local.reconciliation_namespace
    value         = "$.exceptionCount"
    default_value = "0"
    unit          = "Count"
  }
}

# Filter: emit metric for total transactions compared per run
resource "aws_cloudwatch_log_metric_filter" "reconciliation_transactions_compared" {
  name           = "reconciliation-transactions-compared"
  log_group_name = aws_cloudwatch_log_group.reconciliation_job.name
  pattern        = "{ $.msg = \"Reconciliation job completed\" }"

  metric_transformation {
    name          = "ReconciliationTransactionsCompared"
    namespace     = local.reconciliation_namespace
    value         = "$.transactionsCompared"
    default_value = "0"
    unit          = "Count"
  }
}

# Alarm 1: CRITICAL — any non-zero exception count for a completed run (AC4)
resource "aws_cloudwatch_metric_alarm" "reconciliation_exceptions_nonzero" {
  alarm_name          = "CRITICAL-reconciliation-exceptions"
  alarm_description   = "Daily reconciliation job found unreconciled payment exceptions. Objective O3 (zero-exception gate) is breached. See runbook: docs/runbooks/payment-reconciliation-exception.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ReconciliationExceptions"
  namespace           = local.reconciliation_namespace
  period              = 86400 # 24 hours
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.platform_page_actions[0]]
  ok_actions          = [local.platform_page_actions[0]]

  tags = local.common_tags
}

# Alarm 2: CRITICAL — no completed run in 26 hours (missed run / task crash) (AC4)
resource "aws_cloudwatch_metric_alarm" "reconciliation_missed_run" {
  alarm_name          = "CRITICAL-reconciliation-missed-run"
  alarm_description   = "No reconciliation run completed in the last 26 hours. The EventBridge schedule may have failed, the ECS task may be crashing, or the run cursor is stuck. Check /ecs/${var.environment}/reconciliation-job CloudWatch Logs."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ReconciliationTransactionsCompared"
  namespace           = local.reconciliation_namespace
  period              = 93600 # 26 hours
  statistic           = "SampleCount"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [local.platform_page_actions[0]]
  ok_actions          = [local.platform_page_actions[0]]

  tags = local.common_tags
}
