resource "aws_cloudwatch_log_group" "service" {
  name              = var.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_group_kms_key_arn != "" ? var.log_group_kms_key_arn : null

  tags = merge(var.common_tags, {
    Name        = var.log_group_name
    Service     = var.service_name
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}
