# expiry_sweep.tf — EventBridge-scheduled ECS task for the PENDING booking
# expiry sweep (WO-043).
#
# Architecture:
#   EventBridge Scheduler (rate 5 minutes)
#     → ECS RunTask (Fargate, one-shot, no long-running service)
#       → booking-service image, command: node dist/jobs/expirySweep.js
#
# The task is NOT started in-process by the HTTP service replicas. Running as
# a one-off ECS task prevents the sweep from multiplying across service pods.
#
# IAM:
#   execution role: ECR pull + Secrets Manager (DATABASE_URL, queue secrets)
#   task role:      CloudWatch Logs PutLogEvents only
#                   (no S3, no KMS, no SQS write — queue adapter uses
#                    ambient IAM task role for SQS via instance metadata)

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "expiry_sweep_image" {
  description = "Docker image URI for the expiry sweep task (same image as booking-service)"
  type        = string
}

variable "sqs_queue_url_prefix" {
  description = "SQS queue URL prefix for the booking.expired event topic"
  type        = string
  default     = ""
}

variable "amqp_url_secret_arn" {
  description = "Secrets Manager ARN for the AMQP connection URL (RabbitMQ fallback)"
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# IAM — Execution Role (ECR pull + Secrets Manager read)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "expiry_sweep_execution" {
  name = "${var.environment}-expiry-sweep-execution-role"

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

resource "aws_iam_role_policy_attachment" "expiry_sweep_execution_policy" {
  role       = aws_iam_role.expiry_sweep_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "expiry_sweep_secrets" {
  name = "secrets-read"
  role = aws_iam_role.expiry_sweep_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [var.database_url_secret_arn]
    }]
  })
}

# ---------------------------------------------------------------------------
# IAM — Task Role (least-privilege runtime)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "expiry_sweep_task" {
  name = "${var.environment}-expiry-sweep-task-role"

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

resource "aws_iam_role_policy" "expiry_sweep_logs" {
  name = "cloudwatch-logs"
  role = aws_iam_role.expiry_sweep_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = "${aws_cloudwatch_log_group.expiry_sweep.arn}:*"
    }]
  })
}

# SQS: send messages to the booking.expired queue
resource "aws_iam_role_policy" "expiry_sweep_sqs" {
  name = "sqs-send"
  role = aws_iam_role.expiry_sweep_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = ["arn:aws:sqs:${var.aws_region}:*:${var.environment}-booking-expired*"]
    }]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "expiry_sweep" {
  name              = "/ecs/${var.environment}/expiry-sweep"
  retention_in_days = 90
  kms_key_id        = var.logs_kms_key_arn

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ECS Task Definition (Fargate, one-shot)
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "expiry_sweep" {
  family                   = "${var.environment}-expiry-sweep"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.expiry_sweep_execution.arn
  task_role_arn            = aws_iam_role.expiry_sweep_task.arn

  container_definitions = jsonencode([{
    name      = "expiry-sweep"
    image     = var.expiry_sweep_image
    essential = true

    command = ["node", "dist/jobs/expirySweep.js"]

    environment = [
      { name = "NODE_ENV",                          value = var.environment },
      { name = "EXPIRY_SWEEP_BATCH_SIZE",           value = "200" },
      { name = "EXPIRY_SWEEP_MAX_BATCHES",          value = "50" },
      { name = "EXPIRY_SWEEP_FAILURE_THRESHOLD",    value = "0.2" },
      { name = "QUEUE_DRIVER",                      value = "sqs" },
      { name = "SQS_QUEUE_URL_PREFIX",              value = var.sqs_queue_url_prefix },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.expiry_sweep.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Security Group — egress to RDS Proxy and SQS only
# ---------------------------------------------------------------------------

resource "aws_security_group" "expiry_sweep" {
  name        = "${var.environment}-expiry-sweep-sg"
  description = "Expiry sweep task — egress to DB proxy and SQS only"
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
    description = "HTTPS — SQS, CloudWatch Logs, Secrets Manager"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.environment}-expiry-sweep-sg" })
}

# ---------------------------------------------------------------------------
# EventBridge IAM — allow the scheduler to run ECS tasks
# ---------------------------------------------------------------------------

resource "aws_iam_role" "eventbridge_expiry_sweep" {
  name = "${var.environment}-eventbridge-expiry-sweep-role"

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

resource "aws_iam_role_policy" "eventbridge_expiry_sweep_ecs" {
  name = "run-ecs-task"
  role = aws_iam_role.eventbridge_expiry_sweep.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = aws_ecs_task_definition.expiry_sweep.arn
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [
          aws_iam_role.expiry_sweep_execution.arn,
          aws_iam_role.expiry_sweep_task.arn,
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# EventBridge Scheduler — every 5 minutes
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule" "expiry_sweep" {
  name                         = "${var.environment}-expiry-sweep"
  description                  = "Run the PENDING booking expiry sweep every 5 minutes"
  schedule_expression          = "rate(5 minutes)"
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.ecs_cluster_arn
    role_arn = aws_iam_role.eventbridge_expiry_sweep.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.expiry_sweep.arn
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [aws_security_group.expiry_sweep.id]
        assign_public_ip = false
      }
    }
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# CloudWatch Alarms (namespace: travel/expiry-sweep)
# ---------------------------------------------------------------------------

locals {
  expiry_sweep_namespace = "travel/expiry-sweep"
}

# Alarm: sustained non-zero backlog — candidates remain after consecutive runs
resource "aws_cloudwatch_metric_alarm" "expiry_sweep_backlog" {
  alarm_name          = "expiry-sweep-sustained-backlog"
  alarm_description   = "Expiry sweep has found candidates in 3 consecutive runs. Possible stuck loop, DB contention, or processing failure. Investigate."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ExpiryCandidatesFound"
  namespace           = local.expiry_sweep_namespace
  period              = 300 # 5 minutes — matches EventBridge schedule
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Alarm: high failure count
resource "aws_cloudwatch_metric_alarm" "expiry_sweep_failures" {
  alarm_name          = "expiry-sweep-high-failure-count"
  alarm_description   = "Expiry sweep per-item failures exceeded threshold. Check /ecs/${var.environment}/expiry-sweep logs."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ExpiryFailedCount"
  namespace           = local.expiry_sweep_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# Alarm: sweep not running — no metric in last 15 minutes
resource "aws_cloudwatch_metric_alarm" "expiry_sweep_not_running" {
  alarm_name          = "expiry-sweep-not-running"
  alarm_description   = "Expiry sweep has not emitted metrics for 15 minutes. EventBridge schedule may have failed or task is not starting."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ExpiryCandidatesFound"
  namespace           = local.expiry_sweep_namespace
  period              = 900 # 15 minutes
  statistic           = "SampleCount"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
}
