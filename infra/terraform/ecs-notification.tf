/**
 * ECS Notification Service — independent consumer with queue-depth autoscaling.
 *
 * This service must NOT share an autoscaling policy with request-path services.
 * It scales independently on ApproximateNumberOfMessagesVisible > 100,
 * which is the alarm produced by the SQS module (WO-051).
 *
 * IAM: least-privilege task role — ses:SendEmail plus the SQS consumer actions
 * only. No read/write to S3, no SSM parameter access.
 *
 * Health check: ECS target group uses /health/ready (deep probe covering
 * postgres, redis, queue, and secrets) on port 8081.
 */

# ---------------------------------------------------------------------------
# ECS Task Definition and Service (via shared module)
# ---------------------------------------------------------------------------

module "notification_service" {
  source = "./modules/ecs-service"

  environment        = var.environment
  service_name       = "notification-service"
  container_image    = var.notification_service_image
  cpu                = 512
  memory             = 1024
  port               = 8081
  desired_count      = 2
  ecs_cluster_arn    = var.ecs_cluster_arn
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [aws_security_group.notification_service.id]
  log_group_name     = "/ecs/${var.environment}/notification-service"
  aws_account_id     = var.aws_account_id
  aws_region         = var.aws_region

  environment_vars = {
    NODE_ENV              = var.environment
    QUEUE_DRIVER          = "sqs"
    SQS_QUEUE_URL         = module.sqs.queue_url
    SES_REGION            = var.aws_region
    SES_FROM_ADDRESS      = var.ses_from_address
    HEALTH_PORT           = "8081"
    SERVICE_VERSION       = var.notification_service_version
  }

  secret_refs = {
    DATABASE_URL = var.database_url_secret_arn
    REDIS_URL    = var.redis_url_secret_arn
  }

  kms_key_arns          = [var.secrets_kms_key_arn]
  rds_connect_policy_arns = [module.rds_proxy.notification_service_rds_connect_policy_arn]

  common_tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Security Group — outbound only (no inbound HTTP; health check is sidecar)
# ---------------------------------------------------------------------------

resource "aws_security_group" "notification_service" {
  name        = "${var.environment}-notification-service"
  description = "Notification service ECS tasks — outbound to SQS, SES, RDS Proxy, Redis"
  vpc_id      = var.vpc_id

  egress {
    description = "HTTPS to AWS service endpoints (SQS, SES, Secrets Manager)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description     = "PostgreSQL via RDS Proxy"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.rds_proxy_security_group_id]
  }

  egress {
    description     = "Redis (ElastiCache)"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.redis_security_group_id]
  }

  tags = merge(local.common_tags, {
    Name    = "${var.environment}-notification-service"
    Service = "notification-service"
  })
}

# ---------------------------------------------------------------------------
# IAM — least-privilege task role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "notification_ses_send" {
  statement {
    sid    = "SesTemplatedSend"
    effect = "Allow"

    actions = [
      "ses:SendEmail",
      "ses:SendTemplatedEmail",
      "sesv2:SendEmail",
    ]

    resources = [
      "arn:aws:ses:${var.aws_region}:${var.aws_account_id}:identity/${var.ses_from_domain}",
      "arn:aws:ses:${var.aws_region}:${var.aws_account_id}:configuration-set/${var.ses_configuration_set_name}",
    ]
  }
}

resource "aws_iam_policy" "notification_ses_send" {
  name        = "${var.environment}-notification-service-ses-send"
  description = "Allow notification-service to send templated emails via SES"
  policy      = data.aws_iam_policy_document.notification_ses_send.json

  tags = merge(local.common_tags, {
    Service = "notification-service"
  })
}

resource "aws_iam_role_policy_attachment" "notification_ses" {
  role       = module.notification_service.task_role_name
  policy_arn = aws_iam_policy.notification_ses_send.arn
}

resource "aws_iam_role_policy_attachment" "notification_sqs_consumer" {
  role       = module.notification_service.task_role_name
  policy_arn = module.sqs.consumer_policy_arn
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "notification_service" {
  name              = "/ecs/${var.environment}/notification-service"
  retention_in_days = 30

  tags = merge(local.common_tags, {
    Service = "notification-service"
  })
}

# ---------------------------------------------------------------------------
# Application Autoscaling — independent of request-path services
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "notification_service" {
  max_capacity       = 10
  min_capacity       = 2
  resource_id        = "service/${var.ecs_cluster_name}/${var.environment}-notification-service"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

  depends_on = [module.notification_service]
}

resource "aws_appautoscaling_policy" "notification_queue_depth" {
  name               = "${var.environment}-notification-queue-depth-scaling"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.notification_service.resource_id
  scalable_dimension = aws_appautoscaling_target.notification_service.scalable_dimension
  service_namespace  = aws_appautoscaling_target.notification_service.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Maximum"

    # Scale out when queue depth > 100
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = 400
      scaling_adjustment          = 1
    }

    # Scale out aggressively when depth > 500
    step_adjustment {
      metric_interval_lower_bound = 400
      scaling_adjustment          = 2
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "notification_scale_out" {
  alarm_name          = "${var.environment}-notification-service-queue-depth-high"
  alarm_description   = "Notification queue depth > 100 — scale out consumer. Runbook: docs/runbooks/dlq-redrive.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 100

  dimensions = {
    QueueName = "${var.environment}-travel-domain-events.fifo"
  }

  alarm_actions = [
    aws_appautoscaling_policy.notification_queue_depth.arn,
    var.monitoring_sns_topic_arn,
  ]

  ok_actions = [var.monitoring_sns_topic_arn]

  tags = merge(local.common_tags, {
    Service = "notification-service"
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Dashboard widget — delivery latency + DLQ depth
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "notification_service" {
  dashboard_name = "${var.environment}-notification-service"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Notification — Delivery Latency (p99)"
          region = var.aws_region
          metrics = [
            ["NotificationService", "delivery_latency_ms", "service", "notification-service", "environment", var.environment, { stat = "p99" }]
          ]
          period = 60
          view   = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Notification — DLQ Depth"
          region = var.aws_region
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${var.environment}-travel-domain-events-dlq.fifo", { stat = "Maximum" }]
          ]
          period = 60
          view   = "timeSeries"
          annotations = {
            horizontal = [{ value = 1, label = "DLQ non-empty" }]
          }
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Notification — Main Queue Depth"
          region = var.aws_region
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${var.environment}-travel-domain-events.fifo", { stat = "Maximum" }]
          ]
          period = 60
          view   = "timeSeries"
          annotations = {
            horizontal = [{ value = 100, label = "Scale-out threshold" }]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Notification — ECS Task Count"
          region = var.aws_region
          metrics = [
            ["AWS/ECS", "RunningTaskCount", "ClusterName", var.ecs_cluster_name, "ServiceName", "${var.environment}-notification-service", { stat = "Average" }]
          ]
          period = 60
          view   = "timeSeries"
        }
      }
    ]
  })
}
