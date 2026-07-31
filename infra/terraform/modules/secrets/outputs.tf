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
