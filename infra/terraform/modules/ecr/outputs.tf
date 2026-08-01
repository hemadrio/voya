output "repository_urls" {
  description = "Map of service name to ECR repository URL."
  value = {
    for name, repo in aws_ecr_repository.service : name => repo.repository_url
  }
}

output "repository_arns" {
  description = "Map of service name to ECR repository ARN."
  value = {
    for name, repo in aws_ecr_repository.service : name => repo.arn
  }
}

output "registry_id" {
  description = "ECR registry ID (AWS account ID)."
  value       = values(aws_ecr_repository.service)[0].registry_id
}
