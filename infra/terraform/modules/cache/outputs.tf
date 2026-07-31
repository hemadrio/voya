output "primary_endpoint_address" {
  description = "Redis primary endpoint address. Use in REDIS_URL as the host (port 6379, TLS required)."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
  sensitive   = true
}

output "reader_endpoint_address" {
  description = "Redis reader endpoint address for read-only commands (searches, session reads)."
  value       = aws_elasticache_replication_group.redis.reader_endpoint_address
  sensitive   = true
}

output "replication_group_id" {
  description = "ElastiCache replication group ID."
  value       = aws_elasticache_replication_group.redis.id
}

output "port" {
  description = "Redis port."
  value       = aws_elasticache_replication_group.redis.port
}

output "cache_security_group_id" {
  description = "Security group ID of the ElastiCache cluster. ECS service SGs are added as ingress sources here."
  value       = aws_security_group.cache.id
}

output "cache_memory_alarm_arn" {
  description = "ARN of the cache memory usage CloudWatch alarm."
  value       = aws_cloudwatch_metric_alarm.cache_memory_usage.arn
}
