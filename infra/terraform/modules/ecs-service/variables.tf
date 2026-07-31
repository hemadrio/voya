variable "environment" {
  type        = string
  description = "Deployment environment name (dev | staging | production)"

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be 'dev', 'staging', or 'production'."
  }
}

variable "service_name" {
  type        = string
  description = "Short service name, e.g. 'auth-service'. Used in resource names and tags."
}

variable "container_image" {
  type        = string
  description = "Fully-qualified container image URI, e.g. 123456789012.dkr.ecr.eu-west-1.amazonaws.com/auth-service:sha-abc123"
}

variable "cpu" {
  type        = number
  description = "Task CPU units (256, 512, 1024, 2048, 4096)."
  default     = 512
}

variable "memory" {
  type        = number
  description = "Task memory in MiB."
  default     = 1024
}

variable "port" {
  type        = number
  description = "Container port the service listens on."
  default     = 3000
}

variable "environment_vars" {
  type        = map(string)
  description = <<-EOT
    Non-secret environment variables injected into the container.
    Must NOT contain any key matching the pattern SECRET|KEY|TOKEN|PASSWORD
    (case-insensitive). Secret values must be declared in secret_refs instead.
  EOT
  default     = {}

  validation {
    condition = !anytrue([
      for k in keys(var.environment_vars) :
      can(regex("(?i)(SECRET|KEY|TOKEN|PASSWORD)", k))
    ])
    error_message = "environment_vars must not contain keys matching SECRET, KEY, TOKEN, or PASSWORD. Move those values to secret_refs."
  }
}

variable "secret_refs" {
  type        = map(string)
  description = <<-EOT
    Map of environment variable name to Secrets Manager secret ARN (valueFrom).
    These are injected into the container via the ECS secrets block at task start.
    The value must be a full secret ARN (arn:aws:secretsmanager:...).
  EOT
  default     = {}
}

variable "kms_key_arns" {
  type        = list(string)
  description = "KMS key ARNs the task execution role must be able to call kms:Decrypt on."
  default     = []
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used to scope IAM policy ARNs."
}

variable "aws_region" {
  type        = string
  description = "AWS region, e.g. eu-west-1."
}

variable "log_group_name" {
  type        = string
  description = "CloudWatch Logs log group name for the service."
}

variable "ecs_cluster_arn" {
  type        = string
  description = "ARN of the ECS cluster to register the service in."
}

variable "subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for the ECS service network configuration."
}

variable "security_group_ids" {
  type        = list(string)
  description = "Security group IDs attached to the ECS service."
}

variable "desired_count" {
  type        = number
  description = "Desired number of running tasks."
  default     = 2
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all resources in this module."
  default     = {}
}

# ── RDS Proxy ────────────────────────────────────────────────────────────────

variable "rds_connect_policy_arns" {
  type        = list(string)
  description = <<-EOT
    List of IAM policy ARNs granting rds-db:connect for this service.
    Provided by the rds-proxy module output `service_rds_connect_policy_arns`.
    When empty (default) no rds-db:connect policy is attached — safe for
    services that do not connect to the database (e.g. search services).
  EOT
  default     = []
}

# ── Telemetry / ADOT ─────────────────────────────────────────────────────────

variable "adot_collector_image" {
  type        = string
  description = "ADOT collector container image URI (public.ecr.aws/aws-observability/aws-otel-collector)."
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.40.0"
}

variable "cloudwatch_namespace" {
  type        = string
  description = "CloudWatch metrics namespace for the ADOT EMF exporter."
  default     = "travel/platform"
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention period in days."
  default     = 30
}

variable "log_group_kms_key_arn" {
  type        = string
  description = "KMS key ARN for CloudWatch Logs server-side encryption. Leave empty to use AWS-managed keys."
  default     = ""
}

variable "health_check_path" {
  type        = string
  description = "HTTP path for the container readiness health check."
  default     = "/health/ready"
}

# ── ALB target group ──────────────────────────────────────────────────────────

variable "target_group_arn" {
  type        = string
  description = "ARN of the ALB target group to attach the ECS service to. Leave empty to skip load balancer registration."
  default     = ""
}

# ── Service Connect ───────────────────────────────────────────────────────────

variable "service_connect_namespace_arn" {
  type        = string
  description = "ARN of the Cloud Map HTTP namespace created by the ecs-cluster module. Required when enable_service_connect=true."
  default     = ""
}

variable "enable_service_connect" {
  type        = bool
  description = "Enable ECS Service Connect for east-west mTLS routing within the cluster namespace."
  default     = false
}

variable "service_connect_port_name" {
  type        = string
  description = "Name for the Service Connect port mapping. Defaults to the service name."
  default     = ""
}

variable "service_connect_discovery_name" {
  type        = string
  description = "Service Connect client alias — the DNS name other services use to reach this one. Defaults to service_name."
  default     = ""
}

# ── SQS permissions (task role) ───────────────────────────────────────────────

variable "sqs_producer_queue_arns" {
  type        = list(string)
  description = "SQS queue ARNs the service may send messages to (sqs:SendMessage). Specific ARNs only — no wildcards."
  default     = []
}

variable "sqs_consumer_queue_arns" {
  type        = list(string)
  description = "SQS queue ARNs the service may receive and delete messages from (sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes). Specific ARNs only."
  default     = []
}

# ── Health check tuning ───────────────────────────────────────────────────────

variable "health_check_start_period" {
  type        = number
  description = "Seconds ECS waits before the container healthCheck starts counting failures. Must exceed Prisma client init time."
  default     = 45
}

# ── Autoscaling ───────────────────────────────────────────────────────────────

variable "enable_autoscaling" {
  type        = bool
  description = "Enable App Auto Scaling for this ECS service. Requires cluster_name to be set."
  default     = false
}

variable "cluster_name" {
  type        = string
  description = "Name of the ECS cluster (e.g. production-travel-platform). Required when enable_autoscaling=true; used to build the App Auto Scaling resource_id."
  default     = ""
}

variable "autoscaling_min_capacity" {
  type        = number
  description = "Minimum number of running tasks. Scale-in will never reduce below this value."
  default     = 1

  validation {
    condition     = var.autoscaling_min_capacity >= 1
    error_message = "autoscaling_min_capacity must be at least 1."
  }
}

variable "autoscaling_max_capacity" {
  type        = number
  description = "Maximum number of running tasks. Must not exceed the account Fargate task quota."
  default     = 10

  validation {
    condition     = var.autoscaling_max_capacity >= var.autoscaling_min_capacity
    error_message = "autoscaling_max_capacity must be >= autoscaling_min_capacity."
  }
}

variable "autoscaling_cpu_target" {
  type        = number
  description = "Target CPU utilization percentage for the target-tracking scaling policy."
  default     = 60

  validation {
    condition     = var.autoscaling_cpu_target > 0 && var.autoscaling_cpu_target <= 100
    error_message = "autoscaling_cpu_target must be between 1 and 100."
  }
}

variable "autoscaling_scale_out_cooldown" {
  type        = number
  description = "Scale-out cooldown in seconds. Short to react quickly to demand spikes."
  default     = 60
}

variable "autoscaling_scale_in_cooldown" {
  type        = number
  description = "Scale-in cooldown in seconds. Must be longer than scale-out to prevent thrashing during fan-out latency windows."
  default     = 300

  validation {
    condition     = var.autoscaling_scale_in_cooldown >= var.autoscaling_scale_out_cooldown
    error_message = "autoscaling_scale_in_cooldown must be >= autoscaling_scale_out_cooldown to prevent thrashing."
  }
}

variable "enable_request_scaling" {
  type        = bool
  description = "Attach an ALB RequestCountPerTarget step-scaling policy in addition to CPU target tracking. Only meaningful when target_group_arn is set."
  default     = false
}

variable "autoscaling_request_threshold" {
  type        = number
  description = "ALB RequestCountPerTarget threshold (sum per evaluation period) that triggers step-scale-out."
  default     = 1000
}

variable "autoscaling_request_alarm_period" {
  type        = number
  description = "CloudWatch alarm evaluation period in seconds for the RequestCountPerTarget alarm."
  default     = 60
}

variable "autoscaling_request_eval_periods" {
  type        = number
  description = "Consecutive evaluation periods that must breach before the step-scaling alarm fires."
  default     = 2
}

variable "autoscaling_step_cooldown" {
  type        = number
  description = "Cooldown in seconds for the ALB request-count step-scaling policy."
  default     = 120
}

variable "autoscaling_step_min_adjustment" {
  type        = number
  description = "MinAdjustmentMagnitude: minimum number of tasks to add regardless of the percentage calculation."
  default     = 1
}

variable "consumer_scaling_queue_name" {
  type        = string
  description = "SQS queue name that drives step scaling for queue-consumer services. When non-empty, CPU and request-based scaling are disabled — the consumer scales only on queue depth."
  default     = ""
}

variable "consumer_scale_out_threshold" {
  type        = number
  description = "SQS ApproximateNumberOfMessagesVisible value above which consumer scale-out fires."
  default     = 100
}

variable "consumer_scale_in_threshold" {
  type        = number
  description = "SQS ApproximateNumberOfMessagesVisible value below which consumer scale-in fires."
  default     = 20
}
