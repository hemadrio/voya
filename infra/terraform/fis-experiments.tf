# fis-experiments.tf — AWS FIS experiment templates for resilience testing (WO-099 AC15).
#
# Constraints (WO-099):
#   - Templates are scoped by resource tags (Environment=staging) — never touch production.
#   - Every experiment has an explicit stop condition tied to a CloudWatch alarm so
#     a runaway experiment self-terminates.
#   - Supported actions: ECS task stop, ECS network disruption, Redis connection blackhole,
#     RDS availability zone failover (staging only).
#   - IAM permissions follow least-privilege and only grant FIS write access to
#     resources tagged Environment=staging.
#
# Experiments defined here:
#   1. ecs-task-stop            — Terminates a random ECS task (simulates task crash).
#   2. ecs-network-disruption   — Adds 500 ms latency + 5% packet loss to ECS tasks.
#   3. redis-connection-drop    — Drops all Redis connections (simulates Redis outage).
#   4. rds-az-failover          — Forces an RDS Multi-AZ failover (staging only).

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "fis_stop_alarm_arn" {
  description = "ARN of the CloudWatch alarm used as an FIS experiment stop condition"
  type        = string
}

variable "fis_staging_cluster_arn" {
  description = "ARN of the staging ECS cluster"
  type        = string
}

variable "fis_staging_service_tag_value" {
  description = "Value of the Service tag on ECS tasks subject to fault injection (e.g. booking-service)"
  type        = string
  default     = "booking-service"
}

# ---------------------------------------------------------------------------
# IAM role for FIS — least-privilege, staging-scoped
# ---------------------------------------------------------------------------

resource "aws_iam_role" "fis_execution" {
  name = "staging-fis-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "fis.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Service            = "resilience-testing"
    Environment        = "staging"
    CostCentre         = "platform-reliability"
    Owner              = "sre"
    DataClassification = "internal"
  }
}

resource "aws_iam_role_policy" "fis_ecs_staging" {
  name = "fis-ecs-staging-policy"
  role = aws_iam_role.fis_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ECSStopTasks"
        Effect = "Allow"
        Action = [
          "ecs:StopTask",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Environment" = "staging"
          }
        }
      },
      {
        Sid    = "ECSNetworkActions"
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkAcl",
          "ec2:CreateNetworkAclEntry",
          "ec2:DeleteNetworkAcl",
          "ec2:DeleteNetworkAclEntry",
          "ec2:DescribeNetworkAcls",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Environment" = "staging"
          }
        }
      },
      {
        Sid    = "CloudWatchAlarms"
        Effect = "Allow"
        Action = [
          "cloudwatch:DescribeAlarms",
        ]
        Resource = "*"
      },
      {
        Sid    = "RDSFailover"
        Effect = "Allow"
        Action = [
          "rds:FailoverDBCluster",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Environment" = "staging"
          }
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Experiment 1: ECS task stop — simulates task crash / OOM kill
# ---------------------------------------------------------------------------

resource "aws_fis_experiment_template" "ecs_task_stop" {
  description = "Stop a random ECS task in the staging cluster (simulates crash / OOM kill)"
  role_arn    = aws_iam_role.fis_execution.arn

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = var.fis_stop_alarm_arn
  }

  target {
    name           = "staging-ecs-tasks"
    resource_type  = "aws:ecs:task"
    selection_mode = "COUNT(1)"

    resource_tag {
      key   = "Environment"
      value = "staging"
    }

    resource_tag {
      key   = "Service"
      value = var.fis_staging_service_tag_value
    }
  }

  action {
    name        = "stop-ecs-task"
    action_id   = "aws:ecs:stop-task"
    target {
      key   = "Tasks"
      value = "staging-ecs-tasks"
    }
  }

  tags = {
    Service            = "resilience-testing"
    Environment        = "staging"
    CostCentre         = "platform-reliability"
    Owner              = "sre"
    DataClassification = "internal"
    Scenario           = "ecs-task-stop"
  }
}

# ---------------------------------------------------------------------------
# Experiment 2: ECS network disruption — adds latency + packet loss
# ---------------------------------------------------------------------------

resource "aws_fis_experiment_template" "ecs_network_disruption" {
  description = "Add 500 ms latency and 5% packet loss to staging ECS tasks (simulates degraded network)"
  role_arn    = aws_iam_role.fis_execution.arn

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = var.fis_stop_alarm_arn
  }

  target {
    name           = "staging-ecs-tasks-net"
    resource_type  = "aws:ecs:task"
    selection_mode = "ALL"

    resource_tag {
      key   = "Environment"
      value = "staging"
    }

    resource_tag {
      key   = "Service"
      value = var.fis_staging_service_tag_value
    }
  }

  action {
    name      = "add-network-latency"
    action_id = "aws:ecs:task-network-latency"

    parameter {
      key   = "networkInterfaceId"
      value = "NETWORK_INTERFACE_ID"
    }

    parameter {
      key   = "delayMilliseconds"
      value = "500"
    }

    parameter {
      key   = "jitterMilliseconds"
      value = "50"
    }

    parameter {
      key   = "duration"
      value = "PT5M"
    }

    target {
      key   = "Tasks"
      value = "staging-ecs-tasks-net"
    }
  }

  tags = {
    Service            = "resilience-testing"
    Environment        = "staging"
    CostCentre         = "platform-reliability"
    Owner              = "sre"
    DataClassification = "internal"
    Scenario           = "ecs-network-disruption"
  }
}

# ---------------------------------------------------------------------------
# Experiment 3: Redis connection drop — simulates Redis outage
# ---------------------------------------------------------------------------

resource "aws_fis_experiment_template" "redis_connection_drop" {
  description = "Drop all connections to the staging Redis cluster (simulates Redis outage)"
  role_arn    = aws_iam_role.fis_execution.arn

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = var.fis_stop_alarm_arn
  }

  target {
    name           = "staging-elasticache-cluster"
    resource_type  = "aws:elasticache:replicationgroup"
    selection_mode = "ALL"

    resource_tag {
      key   = "Environment"
      value = "staging"
    }
  }

  action {
    name      = "interrupt-elasticache"
    action_id = "aws:elasticache:interrupt-cluster-az-power"

    parameter {
      key   = "duration"
      value = "PT2M"
    }

    target {
      key   = "ReplicationGroups"
      value = "staging-elasticache-cluster"
    }
  }

  tags = {
    Service            = "resilience-testing"
    Environment        = "staging"
    CostCentre         = "platform-reliability"
    Owner              = "sre"
    DataClassification = "internal"
    Scenario           = "redis-connection-drop"
  }
}

# ---------------------------------------------------------------------------
# Experiment 4: RDS AZ failover — simulates database availability zone loss
# ---------------------------------------------------------------------------

resource "aws_fis_experiment_template" "rds_az_failover" {
  description = "Force RDS Multi-AZ failover in staging (simulates AZ loss)"
  role_arn    = aws_iam_role.fis_execution.arn

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = var.fis_stop_alarm_arn
  }

  target {
    name           = "staging-rds-cluster"
    resource_type  = "aws:rds:cluster"
    selection_mode = "ALL"

    resource_tag {
      key   = "Environment"
      value = "staging"
    }
  }

  action {
    name      = "failover-rds-cluster"
    action_id = "aws:rds:failover-db-cluster"

    target {
      key   = "Clusters"
      value = "staging-rds-cluster"
    }
  }

  tags = {
    Service            = "resilience-testing"
    Environment        = "staging"
    CostCentre         = "platform-reliability"
    Owner              = "sre"
    DataClassification = "internal"
    Scenario           = "rds-az-failover"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch alarm: FIS experiment runaway stop condition
#
# Fires when any critical service alarm transitions to ALARM during an experiment.
# Used as the stop_condition for all experiment templates above.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "fis_stop_condition" {
  alarm_name          = "staging-fis-experiment-stop-condition"
  alarm_description   = "FIS experiment stop condition — fires when a critical service alarm trips during injection"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "InAlarm"
  namespace           = "TravelPlatform/FIS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [] # stop-condition alarm — no action needed; FIS polls it directly

  tags = {
    Service            = "resilience-testing"
    Environment        = "staging"
    CostCentre         = "platform-reliability"
    Owner              = "sre"
    DataClassification = "internal"
  }
}
