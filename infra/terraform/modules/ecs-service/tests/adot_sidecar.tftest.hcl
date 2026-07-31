# Terraform unit tests for the ecs-service module.
# Verifies: ADOT sidecar presence and reservation, log retention, health check
# path, and absence of wildcard IAM actions in the telemetry policy.
#
# Run with: terraform test
# Requires Terraform >= 1.6.0 for mock_provider support.

mock_provider "aws" {}

variables {
  environment        = "dev"
  service_name       = "test-service"
  container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/test-service:latest"
  aws_account_id     = "123456789012"
  aws_region         = "eu-west-1"
  log_group_name     = "/ecs/dev/test-service"
  ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev-travel-platform"
  subnet_ids         = ["subnet-12345678"]
  security_group_ids = ["sg-12345678"]
}

# ── Assert: ADOT sidecar present with ratified reservation ───────────────────

run "adot_sidecar_present_and_sized" {
  command = plan

  assert {
    condition = length([
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
      if c.name == "adot-collector"
    ]) == 1
    error_message = "Task definition must contain exactly one adot-collector sidecar container"
  }

  assert {
    condition = [
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
      if c.name == "adot-collector"
    ][0].cpu == 256
    error_message = "ADOT sidecar must reserve exactly 256 CPU units"
  }

  assert {
    condition = [
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
      if c.name == "adot-collector"
    ][0].memory == 512
    error_message = "ADOT sidecar must reserve exactly 512 MB memory"
  }

  assert {
    condition = [
      for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
      if c.name == "adot-collector"
    ][0].essential == false
    error_message = "ADOT sidecar must have essential=false so a collector crash does not kill the application container"
  }
}

# ── Assert: application container has two containers total ───────────────────

run "exactly_two_containers" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.service.container_definitions)) == 2
    error_message = "Task definition must contain exactly 2 containers (application + adot-collector)"
  }
}

# ── Assert: log group retention is 30 days ───────────────────────────────────

run "log_retention_thirty_days" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.service.retention_in_days == 30
    error_message = "CloudWatch log group must have 30-day retention"
  }
}

# ── Assert: application container health check uses /health/ready ────────────

run "health_check_path_ready" {
  command = plan

  assert {
    condition = strcontains(
      [
        for c in jsondecode(aws_ecs_task_definition.service.container_definitions) : c
        if c.name == "test-service"
      ][0].healthCheck.command[1],
      "/health/ready"
    )
    error_message = "Application container health check command must reference /health/ready"
  }
}

# ── Assert: deployment circuit breaker and percentages ───────────────────────

run "deployment_circuit_breaker_enabled" {
  command = plan

  assert {
    condition     = aws_ecs_service.service.deployment_minimum_healthy_percent == 100
    error_message = "ECS service must have deployment_minimum_healthy_percent = 100"
  }

  assert {
    condition     = aws_ecs_service.service.deployment_maximum_percent == 200
    error_message = "ECS service must have deployment_maximum_percent = 200"
  }
}

# ── Assert: telemetry IAM policy contains no wildcard actions ────────────────

run "iam_no_wildcard_log_actions" {
  command = plan

  assert {
    condition     = !strcontains(data.aws_iam_policy_document.telemetry.json, "\"logs:*\"")
    error_message = "Telemetry policy must not grant wildcard CloudWatch Logs actions"
  }

  assert {
    condition     = !strcontains(data.aws_iam_policy_document.telemetry.json, "\"cloudwatch:*\"")
    error_message = "Telemetry policy must not grant wildcard CloudWatch metrics actions"
  }

  assert {
    condition     = strcontains(data.aws_iam_policy_document.telemetry.json, "cloudwatch:namespace")
    error_message = "Telemetry policy must scope CloudWatch PutMetricData with a namespace condition"
  }
}
