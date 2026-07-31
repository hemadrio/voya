# Terraform unit tests — service sizing, secrets-only injection, Service Connect.
# Run with: terraform test
# Requires Terraform >= 1.6.0 for mock_provider support.

mock_provider "aws" {}

# ── Default variable set (auth-service sizing) ────────────────────────────────

variables {
  environment        = "dev"
  service_name       = "auth-service"
  container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/auth-service:latest"
  aws_account_id     = "123456789012"
  aws_region         = "eu-west-1"
  log_group_name     = "/ecs/dev/auth-service"
  ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
  subnet_ids         = ["subnet-12345678"]
  security_group_ids = ["sg-12345678"]
  cpu                = 512
  memory             = 1024
  port               = 3001
}

# ── Assert: CPU and memory match declared sizing ──────────────────────────────

run "cpu_memory_match_declared_values" {
  command = plan

  assert {
    condition     = aws_ecs_task_definition.service.cpu == "512"
    error_message = "auth-service task CPU must be 512 units"
  }

  assert {
    condition     = aws_ecs_task_definition.service.memory == "1024"
    error_message = "auth-service task memory must be 1024 MiB"
  }
}

# ── Assert: search service sizing (1 vCPU / 2 GB) ─────────────────────────────

run "search_service_sizing" {
  command = plan

  variables {
    service_name = "flight-service"
    cpu          = 1024
    memory       = 2048
    port         = 3003
  }

  assert {
    condition     = aws_ecs_task_definition.service.cpu == "1024"
    error_message = "flight-service CPU must be 1024 (1 vCPU)"
  }

  assert {
    condition     = aws_ecs_task_definition.service.memory == "2048"
    error_message = "flight-service memory must be 2048 MiB (2 GB)"
  }
}

# ── Assert: api-gateway sizing (2 vCPU / 4 GB) ────────────────────────────────

run "api_gateway_sizing" {
  command = plan

  variables {
    service_name = "api-gateway"
    cpu          = 2048
    memory       = 4096
    port         = 3000
  }

  assert {
    condition     = aws_ecs_task_definition.service.cpu == "2048"
    error_message = "api-gateway CPU must be 2048 (2 vCPU)"
  }

  assert {
    condition     = aws_ecs_task_definition.service.memory == "4096"
    error_message = "api-gateway memory must be 4096 MiB (4 GB)"
  }
}

# ── Assert: secrets-only credential injection ─────────────────────────────────
# The environment block must NOT contain JWT_SECRET, DATABASE_URL, or STRIPE.
# Credentials go in the secrets block (valueFrom ARNs), never plaintext.

run "no_plaintext_credentials_in_environment" {
  command = plan

  variables {
    secret_refs = {
      JWT_SECRET   = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/jwt-signing-key"
      DATABASE_URL = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/db-url"
    }
    environment_vars = {
      NODE_ENV = "dev"
      PORT     = "3001"
    }
  }

  assert {
    condition = !anytrue([
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) :
      anytrue([
        for e in try(c.environment, []) :
        can(regex("(?i)(SECRET|KEY|TOKEN|PASSWORD|URL.*://.+:.+@)", e.value))
      ])
      if c.name == "auth-service"
    ])
    error_message = "No plaintext credential values should appear in the environment block"
  }

  assert {
    condition = length([
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) :
      c
      if c.name == "auth-service"
    ][0].secrets) == 2
    error_message = "auth-service must have exactly 2 secrets injected (JWT_SECRET, DATABASE_URL)"
  }
}

# ── Assert: secrets block uses valueFrom ARNs (not plaintext values) ──────────

run "secrets_use_valuefrom_arns" {
  command = plan

  variables {
    secret_refs = {
      JWT_SECRET = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:dev/jwt-signing-key"
    }
  }

  assert {
    condition = alltrue([
      for s in [
        for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
        if c.name == "auth-service"
      ][0].secrets :
      startswith(s.valueFrom, "arn:aws:secretsmanager:")
    ])
    error_message = "All secrets must reference Secrets Manager ARNs via valueFrom"
  }
}

# ── Assert: notification-consumer: no load balancer when target_group_arn empty ─

run "notification_consumer_no_load_balancer" {
  command = plan

  variables {
    service_name     = "notification-consumer"
    port             = 3009
    target_group_arn = ""
  }

  assert {
    condition     = length(aws_ecs_service.service.load_balancer) == 0
    error_message = "notification-consumer must not have a load_balancer block when target_group_arn is empty"
  }
}

# ── Assert: health check startPeriod is 45 seconds (default) ─────────────────

run "health_check_start_period_default_45s" {
  command = plan

  assert {
    condition = [
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
      if c.name == "auth-service"
    ][0].healthCheck.startPeriod == 45
    error_message = "Default health check startPeriod must be 45 seconds to cover Prisma init"
  }
}

# ── Assert: Service Connect port name in portMappings ────────────────────────

run "service_connect_port_name_in_mappings" {
  command = plan

  assert {
    condition = [
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
      if c.name == "auth-service"
    ][0].portMappings[0].name == "auth-service"
    error_message = "portMappings must include a 'name' field for Service Connect"
  }
}

# ── Assert: log driver is awslogs ────────────────────────────────────────────

run "log_driver_is_awslogs" {
  command = plan

  assert {
    condition = [
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
      if c.name == "auth-service"
    ][0].logConfiguration.logDriver == "awslogs"
    error_message = "Application container must use the awslogs log driver"
  }
}

# ── Assert: distinct execution and task role names ────────────────────────────

run "distinct_execution_and_task_roles" {
  command = plan

  assert {
    condition     = aws_iam_role.task_execution.name == "dev-auth-service-exec"
    error_message = "Task execution role name must be '<env>-<service>-exec'"
  }

  assert {
    condition     = aws_iam_role.task_role.name == "dev-auth-service-task"
    error_message = "Task role name must be '<env>-<service>-task'"
  }

  assert {
    condition     = aws_iam_role.task_execution.name != aws_iam_role.task_role.name
    error_message = "Execution role and task role must have distinct names"
  }
}
