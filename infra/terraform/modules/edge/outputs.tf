/**
 * outputs.tf — Edge module outputs consumed by ECS service definitions (WO-081)
 * and environment root modules.
 */

# ── Target group ARNs (consumed by ECS service definitions in WO-081) ─────────

output "target_group_arns" {
  description = "Map of service name → target group ARN. Consumed by ECS service module for load-balancer registration."
  value       = { for name, tg in aws_lb_target_group.services : name => tg.arn }
}

output "api_gateway_target_group_arn" {
  description = "ARN of the api-gateway target group attached to the public ALB listener."
  value       = aws_lb_target_group.services["api-gateway"].arn
}

# ── ALB DNS names ──────────────────────────────────────────────────────────────

output "public_alb_dns_name" {
  description = "DNS name of the internet-facing ALB. Used as the CloudFront origin and for smoke-test assertions."
  value       = aws_lb.public.dns_name
}

output "public_alb_arn" {
  description = "ARN of the internet-facing ALB."
  value       = aws_lb.public.arn
}

output "internal_alb_dns_name" {
  description = "DNS name of the internal ALB. Services call this from within the VPC."
  value       = aws_lb.internal.dns_name
}

output "internal_alb_arn" {
  description = "ARN of the internal ALB."
  value       = aws_lb.internal.arn
}

# ── CloudFront ─────────────────────────────────────────────────────────────────

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (e.g. d1abc.cloudfront.net)."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID."
  value       = aws_cloudfront_distribution.main.id
}

output "cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.main.arn
}

# ── WAF ────────────────────────────────────────────────────────────────────────

output "waf_web_acl_arn" {
  description = "ARN of the WAF WebACL attached to CloudFront."
  value       = aws_wafv2_web_acl.main.arn
}

output "waf_web_acl_id" {
  description = "ID of the WAF WebACL."
  value       = aws_wafv2_web_acl.main.id
}

# ── Certificates ───────────────────────────────────────────────────────────────

output "acm_certificate_regional_arn" {
  description = "ARN of the regional ACM certificate (for the public and internal ALBs)."
  value       = aws_acm_certificate.regional.arn
}

output "acm_certificate_cloudfront_arn" {
  description = "ARN of the us-east-1 ACM certificate (for CloudFront)."
  value       = aws_acm_certificate.cloudfront.arn
}

# ── Origin secret ──────────────────────────────────────────────────────────────

output "origin_header_secret_arn" {
  description = "Secrets Manager ARN for the CloudFront origin secret. Rotate by updating current/previous JSON values."
  value       = aws_secretsmanager_secret.origin_header.arn
  sensitive   = false # ARN is not secret; the value inside is.
}

# ── WAF log storage ────────────────────────────────────────────────────────────

output "waf_log_bucket_name" {
  description = "Name of the S3 bucket receiving WAF logs via Kinesis Firehose."
  value       = aws_s3_bucket.waf_logs.id
}

output "waf_log_bucket_arn" {
  description = "ARN of the WAF log S3 bucket."
  value       = aws_s3_bucket.waf_logs.arn
}
