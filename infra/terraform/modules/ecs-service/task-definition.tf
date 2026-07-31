/**
 * ECS Task Definition — secrets injected at runtime via valueFrom ARNs.
 *
 * POLICY: No secret may appear in the environment block. The validation rule
 * on var.environment_vars rejects keys matching SECRET|KEY|TOKEN|PASSWORD at
 * plan time. All credentials are declared in var.secret_refs and rendered into
 * the container_definitions secrets array so ECS resolves them from Secrets
 * Manager before the container starts.
 *
 * Every task definition includes an ADOT collector sidecar (essential=false)
 * that receives OTLP telemetry on the loopback interface and exports traces to
 * X-Ray and metrics to CloudWatch EMF. Binding to 127.0.0.1 prevents external
 * span injection from outside the task network namespace.
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
  container_name = var.service_name

  environment_block = [
    for k, v in var.environment_vars : { name = k, value = v }
  ]

  secrets_block = [
    for k, arn in var.secret_refs : { name = k, valueFrom = arn }
  ]

  # Read collector config at plan time; the ADOT container substitutes
  # ${AWS_DEFAULT_REGION} at runtime from the container environment.
  collector_config = file("${path.module}/collector-config.yaml")
}

resource "aws_ecs_task_definition" "service" {
  family                   = "${var.environment}-${var.service_name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory

  execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arn      = aws_iam_role.task_role.arn

  container_definitions = jsonencode([
    {
      name      = local.container_name
      image     = var.container_image
      essential = true

      portMappings = [
        {
          containerPort = var.port
          protocol      = "tcp"
        }
      ]

      environment = local.environment_block

      # All credentials are resolved from Secrets Manager before container start.
      # The task execution role must have secretsmanager:GetSecretValue for each ARN.
      secrets = local.secrets_block

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = var.service_name
          # awslogs-datetime-format intentionally omitted — Pino emits single-line
          # JSON; adding a datetime format would cause CloudWatch to split on
          # non-JSON lines and corrupt structured log records.
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:${var.port}${var.health_check_path} || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    },
    {
      name      = "adot-collector"
      image     = var.adot_collector_image
      essential = false

      cpu    = 256
      memory = 512

      environment = [
        { name = "AWS_DEFAULT_REGION", value = var.aws_region },
        # Inline YAML config; the collector substitutes ${AWS_DEFAULT_REGION} at startup.
        { name = "AOT_CONFIG_CONTENT", value = local.collector_config },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "adot-collector"
        }
      }
    }
  ])

  # create_before_destroy ensures the previous task definition revision stays
  # registered until the new revision is active, allowing ECS to roll back
  # without capacity dip if the circuit breaker fires.
  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-${var.service_name}-task"
    Environment = var.environment
    Service     = var.service_name
    ManagedBy   = "terraform"
  })
}

resource "aws_ecs_service" "service" {
  name            = "${var.environment}-${var.service_name}"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.service.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn != "" ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = local.container_name
      container_port   = var.port
    }
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-${var.service_name}"
    Environment = var.environment
    Service     = var.service_name
    ManagedBy   = "terraform"
  })

  lifecycle {
    # Allow external deployments (CI/CD) to update the task definition revision
    # without Terraform rolling back to the committed image tag.
    ignore_changes = [task_definition, desired_count]
  }
}
