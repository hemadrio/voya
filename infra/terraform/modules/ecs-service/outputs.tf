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
