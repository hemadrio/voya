output "key_arns" {
  description = "Map of store name to KMS key ARN. Use these in aws_secretsmanager_secret, RDS, ElastiCache, S3 and SQS kms_key_id arguments."
  value = {
    for store, key in aws_kms_key.store : store => key.arn
  }
}

output "key_ids" {
  description = "Map of store name to KMS key ID."
  value = {
    for store, key in aws_kms_key.store : store => key.key_id
  }
}

output "alias_arns" {
  description = "Map of store name to KMS alias ARN."
  value = {
    for store, alias in aws_kms_alias.store : store => alias.arn
  }
}
