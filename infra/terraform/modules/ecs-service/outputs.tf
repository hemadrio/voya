output "task_definition_arn" {
  description = "ARN of the latest ECS task definition revision."
  value       = aws_ecs_task_definition.service.arn
}

output "service_name" {
  description = "Name of the ECS service."
  value       = aws_ecs_service.service.name
}

output "task_execution_role_arn" {
  description = "ARN of the task execution IAM role (used by the ECS agent to pull images and retrieve secrets)."
  value       = aws_iam_role.task_execution.arn
}

output "task_role_arn" {
  description = "ARN of the task IAM role (assumed by application code inside the container)."
  value       = aws_iam_role.task_role.arn
}

output "task_role_name" {
  description = "Name of the task IAM role. Used by callers that attach additional policies (e.g. SES, SQS consumer)."
  value       = aws_iam_role.task_role.name
}

output "log_group_name" {
  description = "Name of the CloudWatch log group created for this service."
  value       = aws_cloudwatch_log_group.service.name
}

output "autoscaling_target_resource_id" {
  description = "App Auto Scaling resource ID for the ECS service. Empty string when enable_autoscaling=false."
  value       = var.enable_autoscaling ? aws_appautoscaling_target.this[0].resource_id : ""
}

output "migration_task_definition_arn" {
  description = "ARN of the migration-runner ECS task definition. Empty string when enable_migration_task=false. Pass to the pipeline RunTask step."
  value       = var.enable_migration_task ? aws_ecs_task_definition.migration_runner[0].arn : ""
}

output "migration_task_role_arn" {
  description = "ARN of the migration-runner task IAM role (DDL-capable). Empty string when enable_migration_task=false."
  value       = var.enable_migration_task ? aws_iam_role.migration_task_role[0].arn : ""
}

output "migration_log_group_name" {
  description = "CloudWatch log group for migration runner output. Empty string when enable_migration_task=false."
  value       = var.enable_migration_task ? aws_cloudwatch_log_group.migration[0].name : ""
}
