output "proxy_endpoint" {
  description = "RDS Proxy endpoint hostname. Use in DATABASE_URL as the host instead of the direct RDS endpoint."
  value       = aws_db_proxy.main.endpoint
}

output "proxy_arn" {
  description = "RDS Proxy ARN."
  value       = aws_db_proxy.main.arn
}

output "proxy_id" {
  description = "RDS Proxy resource ID (used in rds-db:connect IAM resource ARNs as the dbuser path segment)."
  value       = aws_db_proxy.main.id
}

output "proxy_security_group_id" {
  description = "Security group ID of the RDS Proxy. ECS service security groups must be added as an ingress source."
  value       = aws_security_group.proxy.id
}

output "service_rds_connect_policy_arns" {
  description = "Map of service name to the IAM policy ARN granting rds-db:connect for that service."
  value = {
    for name, policy in aws_iam_policy.service_rds_connect : name => policy.arn
  }
}

output "migration_rds_connect_policy_arn" {
  description = "IAM policy ARN granting rds-db:connect for the migration task."
  value       = aws_iam_policy.migration_rds_connect.arn
}

output "purge_worker_rds_connect_policy_arn" {
  description = "IAM policy ARN granting rds-db:connect for the purge worker."
  value       = aws_iam_policy.purge_worker_rds_connect.arn
}
