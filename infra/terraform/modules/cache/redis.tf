/**
 * cache/redis.tf — ElastiCache Redis 7 replication group.
 *
 * Design decisions:
 *   - cache.r7g.large: ~3 GiB usable memory, sufficient for the search working set.
 *   - automatic_failover_enabled + multi_az_enabled: primary promotes in ~60 s
 *     during an AZ failure, matching the RDS Multi-AZ RTO target.
 *   - at_rest_encryption_enabled with a dedicated KMS CMK isolates the blast
 *     radius from RDS and SQS key compromise.
 *   - transit_encryption_enabled (TLS) + auth_token: clients must present the
 *     AUTH token over TLS. The token is stored in Secrets Manager (var.redis_auth_secret_arn).
 *   - snapshot_retention_limit=7: one week of daily snapshots for data recovery.
 *   - ElastiCache being unavailable must degrade services gracefully — this module
 *     only provisions the cluster; service-level circuit breaking is the service's
 *     responsibility.
 */

# ── Auth token (retrieved from Secrets Manager at apply time) ─────────────────
# The auth token must be 16–128 characters, contain only printable ASCII excluding
# spaces, @, and ". We read the stored secret at plan time so Terraform can
# diff the auth_token attribute.

data "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id = var.redis_auth_secret_arn
}

locals {
  redis_auth_token = data.aws_secretsmanager_secret_version.redis_auth.secret_string
}

# ── Security Group ────────────────────────────────────────────────────────────

resource "aws_security_group" "cache" {
  name        = "${var.environment}-travel-cache"
  description = "ElastiCache Redis — accept TLS connections from ECS service tasks only."
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis TLS from ECS service tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.service_sg_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-cache"
    Purpose = "ElastiCache Redis 7"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# ── ElastiCache Subnet Group ─────────────────────────────────────────────────

resource "aws_elasticache_subnet_group" "main" {
  name        = "${var.environment}-travel-cache"
  description = "ElastiCache subnet group for the travel platform Redis cluster."
  subnet_ids  = var.private_app_subnet_ids

  tags = merge(var.common_tags, {
    Name = "${var.environment}-travel-cache-subnet-group"
  })
}

# ── Redis 7 Replication Group ─────────────────────────────────────────────────

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.environment}-travel-cache"
  description          = "Travel platform Redis 7 — search working set (~3 GB), automatic failover, TLS + AUTH."

  engine               = "redis"
  engine_version       = "7.0"
  node_type            = var.node_type
  num_cache_clusters   = var.num_cache_clusters
  port                 = 6379

  # ── Security ─────────────────────────────────────────────────────────────
  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = local.redis_auth_token
  security_group_ids         = [aws_security_group.cache.id]
  subnet_group_name          = aws_elasticache_subnet_group.main.name

  # ── High Availability ──────────────────────────────────────────────────────
  automatic_failover_enabled = true
  multi_az_enabled           = true

  # ── Snapshots ──────────────────────────────────────────────────────────────
  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = "03:00-04:00" # UTC — after RDS backup window

  # ── Maintenance ────────────────────────────────────────────────────────────
  maintenance_window         = "sun:05:00-sun:06:00"
  auto_minor_version_upgrade = true

  apply_immediately = false # Defer changes to maintenance window in production

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-cache"
    Purpose = "Redis 7 search cache and session store"
  })

  lifecycle {
    # auth_token rotation is managed out-of-band; prevent Terraform from
    # triggering a cluster replacement on each apply.
    ignore_changes = [auth_token]
  }
}

# ── CloudWatch alarms ─────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "cache_memory_usage" {
  alarm_name          = "${var.environment}-travel-cache-memory"
  alarm_description   = "ElastiCache Redis memory usage > 80%. Risk of eviction degrading search cache hit rate."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.redis.id
  }

  alarm_actions = [var.alarm_sns_arn]
  ok_actions    = [var.alarm_sns_arn]
  tags          = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "cache_cpu" {
  alarm_name          = "${var.environment}-travel-cache-cpu"
  alarm_description   = "ElastiCache Redis EngineCPUUtilization > 50%. Redis is single-threaded; high CPU indicates long-running commands."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 50
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.redis.id
  }

  alarm_actions = [var.alarm_sns_arn]
  tags          = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "cache_unavailable" {
  alarm_name          = "${var.environment}-travel-cache-unavailable"
  alarm_description   = "ElastiCache current connections dropped to 0 — cluster may be unavailable. Services should degrade to direct supplier calls."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CurrConnections"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.redis.id
  }

  alarm_actions = [var.alarm_sns_arn]
  tags          = var.common_tags
}
