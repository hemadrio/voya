# Terraform plan-level unit tests for autoscaling resources (WO-082).
#
# Verifies (AC1, AC2, AC3, AC4, AC8):
#   - Autoscaling target exists with correct min/max for search services (3/20)
#   - Autoscaling target exists with correct min/max for api-gateway (4/24)
#   - CPU target-tracking policy uses target_value=60, asymmetric cooldowns
#   - ALB step-scaling policy adds 100% capacity (PercentChangeInCapacity)
#   - Notification-consumer uses SQS metric source, not CPU
#   - No CPU or ALB policy when consumer_scaling_queue_name is set
#
# Run: terraform test  (Terraform >= 1.6.0)

mock_provider "aws" {}

# ── Base variable set (shared by all runs) ────────────────────────────────────

variables {
  environment        = "staging"
  service_name       = "flight-service"
  container_image    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/flight-service:latest"
  aws_account_id     = "123456789012"
  aws_region         = "eu-west-1"
  log_group_name     = "/ecs/staging/flight-service"
  ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/staging-travel-platform"
  subnet_ids         = ["subnet-12345678"]
  security_group_ids = ["sg-12345678"]
  port               = 3003
}

# ── AC1/AC2: Search service autoscaling target — min 3 / max 20 ───────────────

run "search_service_autoscaling_target_min3_max20" {
  command = plan

  variables {
    enable_autoscaling       = true
    cluster_name             = "staging-travel-platform"
    autoscaling_min_capacity = 3
    autoscaling_max_capacity = 20
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].min_capacity == 3
    error_message = "Search service autoscaling min_capacity must be 3"
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].max_capacity == 20
    error_message = "Search service autoscaling max_capacity must be 20"
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].scalable_dimension == "ecs:service:DesiredCount"
    error_message = "scalable_dimension must be ecs:service:DesiredCount"
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].service_namespace == "ecs"
    error_message = "service_namespace must be ecs"
  }
}

# ── AC1/AC2: api-gateway autoscaling target — min 4 / max 24 ─────────────────

run "api_gateway_autoscaling_target_min4_max24" {
  command = plan

  variables {
    service_name             = "api-gateway"
    port                     = 3000
    enable_autoscaling       = true
    cluster_name             = "staging-travel-platform"
    autoscaling_min_capacity = 4
    autoscaling_max_capacity = 24
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].min_capacity == 4
    error_message = "api-gateway autoscaling min_capacity must be 4"
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].max_capacity == 24
    error_message = "api-gateway autoscaling max_capacity must be 24"
  }
}

# ── AC2: CPU target-tracking — target_value=60, asymmetric cooldowns ──────────

run "cpu_target_tracking_values" {
  command = plan

  variables {
    enable_autoscaling             = true
    cluster_name                   = "staging-travel-platform"
    autoscaling_min_capacity       = 3
    autoscaling_max_capacity       = 20
    autoscaling_cpu_target         = 60
    autoscaling_scale_out_cooldown = 60
    autoscaling_scale_in_cooldown  = 300
  }

  assert {
    condition     = aws_appautoscaling_policy.cpu_target_tracking[0].policy_type == "TargetTrackingScaling"
    error_message = "CPU scaling policy must be TargetTrackingScaling"
  }

  assert {
    condition     = aws_appautoscaling_policy.cpu_target_tracking[0].target_tracking_scaling_policy_configuration[0].target_value == 60
    error_message = "CPU target value must be 60"
  }

  assert {
    condition     = aws_appautoscaling_policy.cpu_target_tracking[0].target_tracking_scaling_policy_configuration[0].scale_out_cooldown == 60
    error_message = "Scale-out cooldown must be 60 seconds"
  }

  assert {
    condition     = aws_appautoscaling_policy.cpu_target_tracking[0].target_tracking_scaling_policy_configuration[0].scale_in_cooldown == 300
    error_message = "Scale-in cooldown must be 300 seconds (longer than scale-out to prevent thrashing)"
  }

  assert {
    condition = aws_appautoscaling_policy.cpu_target_tracking[0].target_tracking_scaling_policy_configuration[0].predefined_metric_specification[0].predefined_metric_type == "ECSServiceAverageCPUUtilization"
    error_message = "Target tracking must use ECSServiceAverageCPUUtilization predefined metric"
  }
}

# ── AC3: ALB step-scaling — 100% PercentChangeInCapacity ─────────────────────

run "alb_step_scaling_100_percent" {
  command = plan

  variables {
    enable_autoscaling            = true
    cluster_name                  = "staging-travel-platform"
    autoscaling_min_capacity      = 3
    autoscaling_max_capacity      = 20
    enable_request_scaling        = true
    target_group_arn              = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/flight-service/abcdef1234567890"
    autoscaling_request_threshold = 1000
  }

  assert {
    condition     = aws_appautoscaling_policy.request_step_scaling[0].policy_type == "StepScaling"
    error_message = "ALB step scaling policy must be StepScaling"
  }

  assert {
    condition     = aws_appautoscaling_policy.request_step_scaling[0].step_scaling_policy_configuration[0].adjustment_type == "PercentChangeInCapacity"
    error_message = "ALB step scaling adjustment type must be PercentChangeInCapacity"
  }

  assert {
    condition     = aws_appautoscaling_policy.request_step_scaling[0].step_scaling_policy_configuration[0].step_adjustment[0].scaling_adjustment == 100
    error_message = "ALB step scaling must add 100% of current capacity"
  }

  assert {
    condition     = aws_appautoscaling_policy.request_step_scaling[0].step_scaling_policy_configuration[0].min_adjustment_magnitude == 1
    error_message = "ALB step scaling MinAdjustmentMagnitude must be 1"
  }
}

# ── AC3: ALB alarm — 60s period, 2 evaluation periods ────────────────────────

run "alb_alarm_period_and_eval_periods" {
  command = plan

  variables {
    enable_autoscaling            = true
    cluster_name                  = "staging-travel-platform"
    autoscaling_min_capacity      = 3
    autoscaling_max_capacity      = 20
    enable_request_scaling        = true
    target_group_arn              = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/flight-service/abcdef1234567890"
    autoscaling_request_threshold       = 1000
    autoscaling_request_alarm_period    = 60
    autoscaling_request_eval_periods    = 2
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.alb_request_count[0].period == 60
    error_message = "ALB request-count alarm period must be 60 seconds"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.alb_request_count[0].evaluation_periods == 2
    error_message = "ALB request-count alarm must require 2 evaluation periods"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.alb_request_count[0].metric_name == "RequestCountPerTarget"
    error_message = "ALB step-scaling alarm metric must be RequestCountPerTarget"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.alb_request_count[0].namespace == "AWS/ApplicationELB"
    error_message = "ALB step-scaling alarm namespace must be AWS/ApplicationELB"
  }
}

# ── AC4: notification-consumer — SQS metric source, no CPU policy ─────────────

run "consumer_sqs_scaling_uses_sqs_metric_not_cpu" {
  command = plan

  variables {
    service_name                 = "notification-consumer"
    port                         = 3009
    enable_autoscaling           = true
    cluster_name                 = "staging-travel-platform"
    autoscaling_min_capacity     = 3
    autoscaling_max_capacity     = 20
    consumer_scaling_queue_name  = "staging-notifications"
    consumer_scale_out_threshold = 100
    consumer_scale_in_threshold  = 20
  }

  # SQS scale-out alarm references the correct metric
  assert {
    condition     = aws_cloudwatch_metric_alarm.sqs_scale_out[0].metric_name == "ApproximateNumberOfMessagesVisible"
    error_message = "Consumer scale-out alarm must use ApproximateNumberOfMessagesVisible metric"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.sqs_scale_out[0].namespace == "AWS/SQS"
    error_message = "Consumer scale-out alarm must be in the AWS/SQS namespace"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.sqs_scale_out[0].threshold == 100
    error_message = "Consumer scale-out threshold must be 100"
  }

  # Scale-in threshold must be lower than scale-out
  assert {
    condition     = aws_cloudwatch_metric_alarm.sqs_scale_in[0].threshold == 20
    error_message = "Consumer scale-in threshold must be 20"
  }

  # CPU target-tracking must NOT exist for the consumer
  assert {
    condition     = length(aws_appautoscaling_policy.cpu_target_tracking) == 0
    error_message = "notification-consumer must not have a CPU target-tracking policy"
  }

  # ALB step scaling must NOT exist for the consumer
  assert {
    condition     = length(aws_appautoscaling_policy.request_step_scaling) == 0
    error_message = "notification-consumer must not have an ALB request-count step-scaling policy"
  }
}

# ── AC5: DLQ treat_missing_data notBreaching ──────────────────────────────────
# The DLQ alarms are in the SQS module; verified there.
# This run confirms autoscaling is disabled by default (no count resources).

run "autoscaling_disabled_by_default" {
  command = plan

  assert {
    condition     = length(aws_appautoscaling_target.this) == 0
    error_message = "No autoscaling target must exist when enable_autoscaling=false (default)"
  }

  assert {
    condition     = length(aws_appautoscaling_policy.cpu_target_tracking) == 0
    error_message = "No CPU policy must exist when enable_autoscaling=false"
  }
}
