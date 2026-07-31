/**
 * compliance-collector.tf — EventBridge scheduled task for the evidence collector.
 *
 * Runs daily at 06:00 UTC (after purge worker at 02:00 UTC so purge summary
 * evidence is available). The task is NOT a long-running service: it runs,
 * collects evidence, writes artefacts, and exits.
 *
 * IAM: least-privilege — PutObject on evidence bucket only (no DeleteObject).
 */

# ---------------------------------------------------------------------------
# Task execution role (ECR pull + Secrets Manager)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "evidence_collector_execution" {
  name = "${var.environment}-evidence-collector-execution"

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

resource "aws_iam_role_policy_attachment" "evidence_collector_execution_policy" {
  role       = aws_iam_role.evidence_collector_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---------------------------------------------------------------------------
# ECS Task Definition
# ---------------------------------------------------------------------------

variable "evidence_collector_image" {
  description = "Docker image URI for the compliance evidence collector."
  type        = string
  default     = ""
}

variable "evidence_collector_cpu" {
  type    = number
  default = 512
}

variable "evidence_collector_memory" {
  type    = number
  default = 1024
}

resource "aws_ecs_task_definition" "evidence_collector" {
  family                   = "${var.environment}-evidence-collector"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.evidence_collector_cpu
  memory                   = var.evidence_collector_memory
  execution_role_arn       = aws_iam_role.evidence_collector_execution.arn
  task_role_arn            = aws_iam_role.evidence_collector_task.arn

  container_definitions = jsonencode([
    {
      name      = "evidence-collector"
      image     = var.evidence_collector_image
      essential = true
      command   = ["node", "dist/index.js"]

      environment = [
        { name = "ENVIRONMENT",    value = var.environment },
        { name = "NODE_ENV",       value = "production" },
        { name = "LOG_LEVEL",      value = "info" },
        { name = "EVIDENCE_BUCKET", value = aws_s3_bucket.evidence.bucket },
        { name = "AWS_DEFAULT_REGION", value = data.aws_region.current.name },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/${var.environment}/evidence-collector"
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "evidence_collector" {
  name              = "/ecs/${var.environment}/evidence-collector"
  retention_in_days = 90
  tags              = local.common_tags
}

# ---------------------------------------------------------------------------
# EventBridge scheduled rule — daily at 06:00 UTC
# ---------------------------------------------------------------------------

resource "aws_iam_role" "eventbridge_run_collector" {
  name = "${var.environment}-eventbridge-run-evidence-collector"

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

resource "aws_iam_role_policy" "eventbridge_run_collector" {
  name = "run-ecs-task"
  role = aws_iam_role.eventbridge_run_collector.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecs:RunTask"]
      Resource = [aws_ecs_task_definition.evidence_collector.arn]
      Condition = {
        ArnLike = { "ecs:cluster" = var.ecs_cluster_arn }
      }
    }, {
      Effect   = "Allow"
      Action   = ["iam:PassRole"]
      Resource = [
        aws_iam_role.evidence_collector_execution.arn,
        aws_iam_role.evidence_collector_task.arn,
      ]
    }]
  })
}

variable "ecs_cluster_arn" {
  description = "ARN of the ECS cluster to run the evidence collector task."
  type        = string
  default     = ""
}

variable "evidence_collector_subnet_ids" {
  description = "Private subnet IDs for the evidence collector Fargate task."
  type        = list(string)
  default     = []
}

variable "evidence_collector_security_group_ids" {
  description = "Security group IDs for the evidence collector Fargate task."
  type        = list(string)
  default     = []
}

resource "aws_scheduler_schedule" "evidence_collector_daily" {
  name       = "${var.environment}-evidence-collector-daily"
  group_name = "default"

  flexible_time_window { mode = "OFF" }
  schedule_expression = "cron(0 6 * * ? *)"   # 06:00 UTC daily

  target {
    arn      = var.ecs_cluster_arn
    role_arn = aws_iam_role.eventbridge_run_collector.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.evidence_collector.arn
      task_count          = 1
      launch_type         = "FARGATE"

      network_configuration {
        assign_public_ip = false
        subnets          = var.evidence_collector_subnet_ids
        security_groups  = var.evidence_collector_security_group_ids
      }
    }

    retry_policy {
      maximum_retry_attempts = 2
    }
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
