output "cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = aws_ecs_cluster.main.arn
}

output "cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.main.name
}

output "cluster_id" {
  description = "ID of the ECS cluster."
  value       = aws_ecs_cluster.main.id
}

output "service_connect_namespace_arn" {
  description = "ARN of the Cloud Map HTTP namespace used for Service Connect. Pass to each ecs-service module's service_connect_namespace_arn variable."
  value       = aws_service_discovery_http_namespace.service_connect.arn
}

output "service_connect_namespace_name" {
  description = "Name of the Cloud Map HTTP namespace (e.g. production.travel.internal)."
  value       = aws_service_discovery_http_namespace.service_connect.name
}
