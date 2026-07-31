output "db_instance_identifier" {
  description = "RDS DB instance identifier. Pass to the rds-proxy module as rds_instance_identifier."
  value       = aws_db_instance.main.identifier
}

output "db_instance_arn" {
  description = "RDS DB instance ARN."
  value       = aws_db_instance.main.arn
}

output "db_instance_endpoint" {
  description = "RDS instance connection endpoint (host:port). Services must NOT connect here directly — use the proxy endpoint."
  value       = aws_db_instance.main.endpoint
  sensitive   = true # endpoint includes the hostname, which should not leak
}

output "db_instance_address" {
  description = "RDS hostname (without port)."
  value       = aws_db_instance.main.address
  sensitive   = true
}

output "rds_security_group_id" {
  description = "Security group ID of the RDS instance. Pass to the rds-proxy module so it can add an ingress rule."
  value       = aws_security_group.rds.id
}

output "db_subnet_group_name" {
  description = "Name of the DB subnet group."
  value       = aws_db_subnet_group.main.name
}

output "master_user_secret_arn" {
  description = "ARN of the Secrets Manager secret created by RDS for the master user credentials. Pass to the rds-proxy module as db_secret_arn."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "db_name" {
  description = "Database name."
  value       = aws_db_instance.main.db_name
}

output "rds_cpu_alarm_arn" {
  description = "ARN of the RDS CPU CloudWatch alarm."
  value       = aws_cloudwatch_metric_alarm.rds_cpu.arn
}
