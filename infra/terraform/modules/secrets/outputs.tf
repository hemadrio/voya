output "secret_arns" {
  description = "Map of credential slug to Secrets Manager secret ARN. Use these in ECS task definition secrets blocks (valueFrom)."
  value = {
    for slug, secret in aws_secretsmanager_secret.credential : slug => secret.arn
  }
}

output "secret_ids" {
  description = "Map of credential slug to Secrets Manager secret ID (name)."
  value = {
    for slug, secret in aws_secretsmanager_secret.credential : slug => secret.id
  }
}

output "prisma_db_url_secret_arns" {
  description = "Map of service name to Secrets Manager secret ARN for the Prisma DATABASE_URL. Each URL encodes connection_limit=5 and targets the RDS Proxy endpoint."
  value = {
    for svc, secret in aws_secretsmanager_secret.prisma_db_url : svc => secret.arn
  }
}

output "prisma_db_url_secret_ids" {
  description = "Map of service name to Secrets Manager secret ID (name) for the per-service Prisma DATABASE_URL."
  value = {
    for svc, secret in aws_secretsmanager_secret.prisma_db_url : svc => secret.id
  }
}
