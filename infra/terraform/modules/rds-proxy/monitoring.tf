/**
 * CloudWatch alarms for RDS Proxy health and connection governance.
 *
 * Alarms cover the four key failure modes identified in WO-076:
 *   1. DatabaseConnectionsBorrowLatency — proxy is queueing connections;
 *      services will experience latency before they hit errors.
 *   2. ClientConnectionsSetupFailed — proxy is rejecting client connections;
 *      services are experiencing hard failures.
 *   3. DatabaseConnections — server-side connections approaching the ceiling
 *      computed in connection-budget.md; gives ops advance warning.
 *   4. Prisma pool timeout (custom metric) — reported by the observability
 *      package when a Prisma query times out waiting for a connection;
 *      surfaced here so the alarm exists even before the metric has data.
 *
 * All alarms notify the shared SNS topic supplied by var.alarm_sns_arn, which
 * is the same topic used by the ECS service alarms.
 */

locals {
  proxy_name = aws_db_proxy.main.name

  # Approximate DB connection ceiling: max_connections_percent × db.r6g.large
  # max_connections (1802) / 100. Used for the utilisation alarm threshold.
  # See connection-budget.md for the full derivation.
  db_connection_ceiling = floor(1802 * var.max_connections_percent / 100)
  db_connection_alarm_threshold = floor(
    local.db_connection_ceiling * var.connection_utilisation_threshold_pct / 100
  )
}

# ── 1. Borrow latency ─────────────────────────────────────────────────────────
# Fires when the average time the proxy spends finding a pinned server
# connection exceeds the threshold.  Early warning before client errors appear.

resource "aws_cloudwatch_metric_alarm" "borrow_latency" {
  alarm_name          = "${var.environment}-rds-proxy-borrow-latency"
  alarm_description   = "RDS Proxy connection borrow latency > ${var.borrow_latency_threshold_ms}ms — proxy may be saturating its server-side connection budget."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnectionsBorrowLatency"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = var.borrow_latency_threshold_ms
  treat_missing_data  = "notBreaching"

  dimensions = {
    ProxyName = local.proxy_name
  }

  alarm_actions             = [var.alarm_sns_arn]
  ok_actions                = [var.alarm_sns_arn]
  insufficient_data_actions = []

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-rds-proxy-borrow-latency"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ── 2. Client connection setup failures ───────────────────────────────────────
# Any client-connection setup failure is a service impact event. Threshold of
# 1 (i.e. > 0) alerts immediately; two evaluation periods prevents flapping on
# a single blip.

resource "aws_cloudwatch_metric_alarm" "client_connections_failed" {
  alarm_name          = "${var.environment}-rds-proxy-client-connections-failed"
  alarm_description   = "RDS Proxy client connection setup failures detected — services may be unable to reach the database."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ClientConnectionsSetupFailed"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    ProxyName = local.proxy_name
  }

  alarm_actions             = [var.alarm_sns_arn]
  ok_actions                = [var.alarm_sns_arn]
  insufficient_data_actions = []

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-rds-proxy-client-connections-failed"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ── 3. Server-side connection utilisation ────────────────────────────────────
# Fires when the proxy's open server connections approach the computed ceiling.
# Gives the on-call team time to investigate before the migration task or purge
# worker is starved of its reserved allocation.

resource "aws_cloudwatch_metric_alarm" "connection_utilisation" {
  alarm_name          = "${var.environment}-rds-proxy-connection-utilisation"
  alarm_description   = "RDS Proxy DatabaseConnections > ${var.connection_utilisation_threshold_pct}% of budget (${local.db_connection_alarm_threshold}/${local.db_connection_ceiling}) — approaching ceiling; migration/purge slots may be at risk."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Maximum"
  threshold           = local.db_connection_alarm_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    ProxyName = local.proxy_name
  }

  alarm_actions             = [var.alarm_sns_arn]
  ok_actions                = [var.alarm_sns_arn]
  insufficient_data_actions = []

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-rds-proxy-connection-utilisation"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ── 4. Prisma pool timeout (custom metric) ───────────────────────────────────
# The @travel/observability package emits a custom metric
# "travel-platform/PrismaPoolTimeout" (count) whenever a Prisma query times out
# waiting for a connection.  This alarm exists from day one so the metric
# namespace and alarm are in place before the first data point arrives.

resource "aws_cloudwatch_metric_alarm" "prisma_pool_timeout" {
  alarm_name          = "${var.environment}-prisma-pool-timeout"
  alarm_description   = "Prisma connection pool timeouts detected — services may be queuing database requests beyond pool_timeout; investigate connection budget and proxy borrow latency."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "PrismaPoolTimeout"
  namespace           = "travel-platform"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    Environment = var.environment
  }

  alarm_actions             = [var.alarm_sns_arn]
  ok_actions                = [var.alarm_sns_arn]
  insufficient_data_actions = []

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-prisma-pool-timeout"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}
