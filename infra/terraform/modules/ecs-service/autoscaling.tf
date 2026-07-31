/**
 * autoscaling.tf — App Auto Scaling for ECS Fargate services.
 *
 * Three scaling modes, activated by variable combinations:
 *
 *   CPU target tracking (request-handling services):
 *     enable_autoscaling=true, consumer_scaling_queue_name=""
 *     Targets ECSServiceAverageCPUUtilization at 60%, asymmetric cooldowns
 *     (60 s scale-out, 300 s scale-in) to absorb cold-start CPU spikes without
 *     thrashing during the search fan-out latency budget.
 *
 *   ALB step scaling (search services + api-gateway):
 *     enable_request_scaling=true, target_group_arn != ""
 *     Adds 100% capacity (PercentChangeInCapacity) when RequestCountPerTarget
 *     breaches the threshold for two consecutive 60-second periods. Provides the
 *     step-ramp acceleration required to reach 3x capacity inside ten minutes —
 *     CPU target tracking alone takes 12–15 minutes for a 3x ramp.
 *
 *   SQS consumer step scaling (notification-consumer only):
 *     consumer_scaling_queue_name != ""
 *     CPU and request-based policies are disabled. Scale-out fires when
 *     ApproximateNumberOfMessagesVisible > 100, scale-in when < 20.
 *     SQS metric publication lag (~60 s) means consumer scaling reacts one
 *     period later than request-based scaling — expected and documented.
 *
 * Edge cases handled:
 *   - Cold-start CPU spike absorbed by 60 s scale-out cooldown + health_check_grace_period
 *   - Scale-in loses the race to scale-out: 300 s vs 60/120 s cooldowns
 *   - Fargate task launch throttling at high concurrency: step scaling tolerates
 *     partial fulfilment; the next alarm period triggers a follow-on adjustment
 */

locals {
  ecs_service_full_name = "${var.environment}-${var.service_name}"

  # Extract "targetgroup/<name>/<id>" suffix for the RequestCountPerTarget dimension.
  # try() guards against an empty target_group_arn when request scaling is disabled.
  tg_label = try(regex("(targetgroup/.+)", var.target_group_arn)[0], "")

  use_cpu_scaling     = var.enable_autoscaling && var.consumer_scaling_queue_name == ""
  use_request_scaling = var.enable_autoscaling && var.enable_request_scaling && var.target_group_arn != "" && var.consumer_scaling_queue_name == ""
  use_sqs_scaling     = var.enable_autoscaling && var.consumer_scaling_queue_name != ""
}

# ── App Auto Scaling Target ───────────────────────────────────────────────────

resource "aws_appautoscaling_target" "this" {
  count = var.enable_autoscaling ? 1 : 0

  resource_id        = "service/${var.cluster_name}/${local.ecs_service_full_name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
  min_capacity       = var.autoscaling_min_capacity
  max_capacity       = var.autoscaling_max_capacity

  depends_on = [aws_ecs_service.service]
}

# ── Target Tracking — CPU Utilisation ────────────────────────────────────────

resource "aws_appautoscaling_policy" "cpu_target_tracking" {
  count = local.use_cpu_scaling ? 1 : 0

  name               = "${local.ecs_service_full_name}-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value       = var.autoscaling_cpu_target
    scale_out_cooldown = var.autoscaling_scale_out_cooldown
    scale_in_cooldown  = var.autoscaling_scale_in_cooldown
  }
}

# ── Step Scaling — ALB RequestCountPerTarget ──────────────────────────────────
# Policy must exist before the alarm that references its ARN, so declare the
# policy resource first.

resource "aws_appautoscaling_policy" "request_step_scaling" {
  count = local.use_request_scaling ? 1 : 0

  name               = "${local.ecs_service_full_name}-request-step-out"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace

  step_scaling_policy_configuration {
    adjustment_type          = "PercentChangeInCapacity"
    cooldown                 = var.autoscaling_step_cooldown
    min_adjustment_magnitude = var.autoscaling_step_min_adjustment

    step_adjustment {
      scaling_adjustment          = 100
      metric_interval_lower_bound = 0
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_request_count" {
  count = local.use_request_scaling ? 1 : 0

  alarm_name          = "${local.ecs_service_full_name}-alb-request-count"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = var.autoscaling_request_eval_periods
  metric_name         = "RequestCountPerTarget"
  namespace           = "AWS/ApplicationELB"
  period              = var.autoscaling_request_alarm_period
  statistic           = "Sum"
  threshold           = var.autoscaling_request_threshold
  treat_missing_data  = "notBreaching"
  alarm_description   = "ALB RequestCountPerTarget >= ${var.autoscaling_request_threshold} for 2 periods — step-scale-out ${local.ecs_service_full_name}"

  dimensions = {
    TargetGroup = local.tg_label
  }

  alarm_actions = [aws_appautoscaling_policy.request_step_scaling[0].arn]

  tags = var.common_tags
}

# ── SQS Consumer Step Scaling — scale-out ────────────────────────────────────

resource "aws_appautoscaling_policy" "sqs_step_out" {
  count = local.use_sqs_scaling ? 1 : 0

  name               = "${local.ecs_service_full_name}-sqs-step-out"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace

  step_scaling_policy_configuration {
    adjustment_type          = "PercentChangeInCapacity"
    cooldown                 = 60
    min_adjustment_magnitude = 1

    step_adjustment {
      scaling_adjustment          = 100
      metric_interval_lower_bound = 0
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "sqs_scale_out" {
  count = local.use_sqs_scaling ? 1 : 0

  alarm_name          = "${local.ecs_service_full_name}-sqs-depth-scale-out"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.consumer_scale_out_threshold
  treat_missing_data  = "notBreaching"
  alarm_description   = "SQS queue depth > ${var.consumer_scale_out_threshold} — scale out ${local.ecs_service_full_name}"

  dimensions = {
    QueueName = var.consumer_scaling_queue_name
  }

  alarm_actions = [aws_appautoscaling_policy.sqs_step_out[0].arn]

  tags = var.common_tags
}

# ── SQS Consumer Step Scaling — scale-in ─────────────────────────────────────

resource "aws_appautoscaling_policy" "sqs_step_in" {
  count = local.use_sqs_scaling ? 1 : 0

  name               = "${local.ecs_service_full_name}-sqs-step-in"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace

  step_scaling_policy_configuration {
    adjustment_type = "ChangeInCapacity"
    cooldown        = 300

    step_adjustment {
      scaling_adjustment          = -1
      metric_interval_upper_bound = 0
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "sqs_scale_in" {
  count = local.use_sqs_scaling ? 1 : 0

  alarm_name          = "${local.ecs_service_full_name}-sqs-depth-scale-in"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.consumer_scale_in_threshold
  treat_missing_data  = "notBreaching"
  alarm_description   = "SQS queue depth < ${var.consumer_scale_in_threshold} for 2 periods — scale in ${local.ecs_service_full_name}"

  dimensions = {
    QueueName = var.consumer_scaling_queue_name
  }

  alarm_actions = [aws_appautoscaling_policy.sqs_step_in[0].arn]

  tags = var.common_tags
}
