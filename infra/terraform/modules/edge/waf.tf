/**
 * waf.tf — AWS WAF WebACL, Kinesis Firehose delivery stream, and S3 WAF log bucket.
 *
 * WAF WebACL (scope=CLOUDFRONT) must be created in us-east-1 regardless of the
 * workload region. The Kinesis Firehose delivery stream must also be in us-east-1
 * for CloudFront WAF logging. The S3 destination bucket is in the workload region
 * (cross-region delivery is supported by Firehose).
 *
 * Managed rule groups (BLOCK mode, AC2):
 *   - AWSManagedRulesCommonRuleSet      (priority 10)
 *   - AWSManagedRulesKnownBadInputsRuleSet (priority 20)
 *   - AWSManagedRulesSQLiRuleSet        (priority 30)
 *   - AWSManagedRulesAmazonIpReputationList (priority 40)
 *
 * Rate-based rule: 2,000 requests per 300-second window per source IP (priority 50).
 *
 * WAF logs retained for var.waf_log_retention_days (≥ 365 days, see variables.tf
 * validation) to satisfy audit evidence requirements.
 */

# ── S3 bucket for WAF log archive (workload region) ──────────────────────────

resource "aws_s3_bucket" "waf_logs" {
  # Globally unique name: account-id suffix prevents collisions across accounts.
  bucket        = "${var.environment}-travel-waf-logs-${var.aws_account_id}"
  force_destroy = false

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-waf-logs"
    Purpose = "WAF audit logs — 1-year retention for compliance evidence"
  })
}

resource "aws_s3_bucket_public_access_block" "waf_logs" {
  bucket                  = aws_s3_bucket.waf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "waf_logs" {
  bucket = aws_s3_bucket.waf_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "waf_logs" {
  bucket = aws_s3_bucket.waf_logs.id

  rule {
    id     = "waf-log-expiry"
    status = "Enabled"

    expiration {
      days = var.waf_log_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ── IAM role for Kinesis Firehose ────────────────────────────────────────────

data "aws_iam_policy_document" "firehose_assume" {
  statement {
    sid     = "FirehoseAssumeRole"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.aws_account_id]
    }
  }
}

resource "aws_iam_role" "firehose_waf" {
  name               = "${var.environment}-firehose-waf-logs"
  assume_role_policy = data.aws_iam_policy_document.firehose_assume.json
  tags               = var.common_tags
}

data "aws_iam_policy_document" "firehose_waf_s3" {
  statement {
    sid = "S3Write"
    actions = [
      "s3:PutObject",
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
    ]
    resources = [
      aws_s3_bucket.waf_logs.arn,
      "${aws_s3_bucket.waf_logs.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "firehose_waf_s3" {
  name   = "waf-logs-s3-write"
  role   = aws_iam_role.firehose_waf.id
  policy = data.aws_iam_policy_document.firehose_waf_s3.json
}

# ── Kinesis Firehose delivery stream (must be in us-east-1 for CloudFront WAF) ──
#
# The stream name must start with "aws-waf-logs-" — this is an AWS requirement
# for WAF logging configurations.

resource "aws_kinesis_firehose_delivery_stream" "waf_logs" {
  provider    = aws.us_east_1
  name        = "aws-waf-logs-${var.environment}-cloudfront"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose_waf.arn
    bucket_arn = aws_s3_bucket.waf_logs.arn

    # Hive-style partitioning for cost-efficient Athena queries on WAF logs.
    prefix              = "waf-logs/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/"
    error_output_prefix = "waf-logs-errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/"

    compression_format = "GZIP"

    buffering_size     = 5    # MB — flush at 5 MB or after 300 s (whichever first)
    buffering_interval = 300  # seconds
  }

  tags = var.common_tags
}

# ── WAF WebACL (scope=CLOUDFRONT — must be in us-east-1) ─────────────────────

resource "aws_wafv2_web_acl" "main" {
  provider    = aws.us_east_1
  name        = "${var.environment}-cloudfront-waf"
  scope       = "CLOUDFRONT"
  description = "WAF ACL for CloudFront: four AWS managed rule groups in BLOCK mode plus a rate-based rule."

  default_action {
    allow {}
  }

  # ── Rule 1: AWS Common Rule Set (BLOCK) ─────────────────────────────────────
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

    # override_action none {} respects the rule group's own BLOCK actions.
    override_action { none {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.environment}CommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # ── Rule 2: Known Bad Inputs (BLOCK) ────────────────────────────────────────
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20

    override_action { none {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.environment}KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  # ── Rule 3: SQL Injection (BLOCK) ────────────────────────────────────────────
  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 30

    override_action { none {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.environment}SQLiRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # ── Rule 4: Amazon IP Reputation List (BLOCK) ────────────────────────────────
  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 40

    override_action { none {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.environment}IpReputationList"
      sampled_requests_enabled   = true
    }
  }

  # ── Rule 5: Rate-based limit — 2,000 req / 5 min per source IP (BLOCK) ──────
  rule {
    name     = "RateLimitPerSourceIP"
    priority = 50

    action { block {} }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.environment}RateLimitPerIP"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.environment}CloudFrontWAF"
    sampled_requests_enabled   = true
  }

  tags = var.common_tags
}

# ── WAF logging configuration ─────────────────────────────────────────────────

resource "aws_wafv2_web_acl_logging_configuration" "main" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.main.arn
  log_destination_configs = [aws_kinesis_firehose_delivery_stream.waf_logs.arn]
}
