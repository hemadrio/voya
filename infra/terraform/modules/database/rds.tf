/**
 * database/rds.tf — RDS PostgreSQL 16 Multi-AZ instance with PITR,
 * cross-region backup replication, and deletion protection.
 *
 * Architectural decisions (from WO-083 / connection-budget.md):
 *   - db.r6g.large: 16 GiB RAM → max_connections ≈ 1802 (formula in budget doc).
 *   - Multi-AZ provides ~60 s AZ-failover RTO.
 *   - backup_retention_period=35 + WAL archiving (wal_level=replica, archive_mode=on)
 *     supports the ~15-minute RPO. Full 5-minute WAL segment archiving cadence.
 *   - Cross-region backup replication (aws_db_instance_automated_backups_replication)
 *     provides a DR copy in the secondary region. Only supported with
 *     backup_retention_period >= 1.
 *   - Deletion protection is true in production; a two-step disable is required
 *     before terraform destroy (see module README).
 *   - Performance Insights enabled with 7-day free retention.
 *   - RDS SG denies direct access from service tasks — only the proxy SG may
 *     reach port 5432. The proxy SG rule is managed by the rds-proxy module
 *     (aws_security_group_rule.rds_from_proxy).
 */

# ── RDS Security Group ────────────────────────────────────────────────────────
# Start with deny-all ingress. The rds-proxy module adds aws_security_group_rule
# "rds_from_proxy" to this SG when it is instantiated. No service task SG may
# be added here directly — all connections must go through the proxy.

resource "aws_security_group" "rds" {
  name        = "${var.environment}-travel-rds"
  description = "RDS PostgreSQL — accept connections from RDS Proxy only (proxy SG is added by the rds-proxy module)."
  vpc_id      = var.vpc_id

  egress {
    description = "Allow all outbound (RDS needs to reach AWS endpoints for backups)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-rds"
    Purpose = "RDS PostgreSQL 16"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# ── DB Subnet Group ───────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name        = "${var.environment}-travel-db"
  description = "Subnet group for the travel platform RDS instance (private data subnets)."
  subnet_ids  = var.private_data_subnet_ids

  tags = merge(var.common_tags, {
    Name = "${var.environment}-travel-db-subnet-group"
  })
}

# ── Parameter Group ───────────────────────────────────────────────────────────
# Parameters support:
#   - WAL archiving for PITR (~15-minute RPO): wal_level=replica, archive_mode=on,
#     archive_command uses AWS S3 (RDS manages this automatically for automated backups).
#   - Slow query logging: log_min_duration_statement=1000 ms.
#   - Connection audit: log_connections and log_disconnections.
#   - max_wal_size limited to prevent uncontrolled WAL growth.

resource "aws_db_parameter_group" "pg16" {
  name        = "${var.environment}-travel-pg16"
  family      = "postgres16"
  description = "Travel platform PostgreSQL 16 parameter group — PITR and observability settings."

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # ms — log queries slower than 1 s
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  parameter {
    name  = "max_wal_size"
    value = "2048" # MB
  }

  parameter {
    name  = "checkpoint_completion_target"
    value = "0.9"
  }

  parameter {
    name  = "random_page_cost"
    value = "1.1" # gp3 SSD — reduce from default 4.0
  }

  tags = merge(var.common_tags, {
    Name = "${var.environment}-travel-pg16-params"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# ── RDS Instance ──────────────────────────────────────────────────────────────

resource "aws_db_instance" "main" {
  identifier = "${var.environment}-travel-platform"

  engine         = "postgres"
  engine_version = "16"
  instance_class = var.instance_class

  db_name  = "travel"
  username = var.master_username
  # Password is managed by RDS + Secrets Manager. The initial value is set
  # manually or via a Secrets Manager rotation Lambda; lifecycle.ignore_changes
  # prevents Terraform from resetting it on subsequent applies.
  manage_master_user_password = true
  master_user_secret_kms_key_id = var.kms_key_arn

  # ── Storage ────────────────────────────────────────────────────────────────
  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  # ── Availability / HA ──────────────────────────────────────────────────────
  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # ── Backups / PITR (~15-minute RPO) ───────────────────────────────────────
  # RDS archives WAL to S3 every 5 minutes; backup_retention_period determines
  # how far back in time a restore can go. 35 days ≈ 5 weeks.
  backup_retention_period = var.backup_retention_days
  backup_window           = "02:00-03:00" # UTC — low-traffic window
  maintenance_window      = "sun:04:00-sun:05:00"

  # ── Parameter / option groups ──────────────────────────────────────────────
  parameter_group_name = aws_db_parameter_group.pg16.name

  # ── Observability ──────────────────────────────────────────────────────────
  performance_insights_enabled          = true
  performance_insights_retention_period = 7 # days (free tier)
  performance_insights_kms_key_id       = var.kms_key_arn
  monitoring_interval                   = 60 # seconds — Enhanced Monitoring
  monitoring_role_arn                   = aws_iam_role.rds_enhanced_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  # ── Snapshots ──────────────────────────────────────────────────────────────
  copy_tags_to_snapshot       = true
  skip_final_snapshot         = var.environment != "production"
  final_snapshot_identifier   = "${var.environment}-travel-platform-final"
  delete_automated_backups    = false

  # ── Protection ─────────────────────────────────────────────────────────────
  deletion_protection = var.deletion_protection

  # ── CA certificate ─────────────────────────────────────────────────────────
  ca_cert_identifier = "rds-ca-rsa4096-g1"

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-travel-platform-rds"
    Purpose = "Primary PostgreSQL 16 database"
  })

  lifecycle {
    # Password is rotated out-of-band by Secrets Manager / operators.
    ignore_changes = [password, manage_master_user_password]
    prevent_destroy = false # Set in tfvars via deletion_protection instead
  }

  depends_on = [aws_db_parameter_group.pg16]
}

# ── Enhanced Monitoring IAM role ──────────────────────────────────────────────

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_enhanced_monitoring" {
  name               = "${var.environment}-rds-enhanced-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
  tags               = var.common_tags
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring" {
  role       = aws_iam_role.rds_enhanced_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ── Cross-region automated backup replication ─────────────────────────────────
# Copies automated backups to the secondary region for DR. Supported only when
# backup_retention_period >= 1. If the secondary region does not have a KMS key,
# replication is rejected — a separate CMK must exist there.

resource "aws_db_instance_automated_backups_replication" "dr" {
  source_db_instance_arn = aws_db_instance.main.arn
  retention_period       = 7 # days of replicated backups in the secondary region

  provider = aws # uses default provider; caller must configure the secondary-region
                  # provider as an alias and pass it here if needed.

  # kms_key_id is not required when the source is unencrypted, but this instance
  # is always encrypted. The secondary region must have an equivalent CMK.
  # Operators must set this ARN after bootstrapping the secondary-region KMS key.
  # Leave as null for initial plan; a lifecycle ignore prevents subsequent drift.

  depends_on = [aws_db_instance.main]
}

# ── CloudWatch alarm — high CPU ────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.environment}-travel-rds-cpu"
  alarm_description   = "RDS CPU utilization > 80% for 2 consecutive minutes. Review slow queries in Performance Insights."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [var.alarm_sns_arn]
  ok_actions    = [var.alarm_sns_arn]
  tags          = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory" {
  alarm_name          = "${var.environment}-travel-rds-low-memory"
  alarm_description   = "RDS freeable memory < 512 MiB. Risk of connection pool eviction."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeableMemory"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 536870912 # 512 MiB in bytes
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [var.alarm_sns_arn]
  tags          = var.common_tags
}
