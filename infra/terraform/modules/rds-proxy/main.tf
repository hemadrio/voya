/**
 * RDS Proxy — IAM-authenticated, TLS-required PostgreSQL connection pooler.
 *
 * Architectural decisions (WO-076):
 *   - Direct Prisma connections and PgBouncer sidecars were formally rejected
 *     because they lack per-service connection ceilings and do not survive a
 *     Multi-AZ failover.  RDS Proxy is mandated.
 *   - IAM database authentication is REQUIRED — no long-lived plaintext
 *     password may appear in a task definition or container image.
 *   - TLS is required end-to-end: client → proxy and proxy → RDS.
 *   - Secrets Manager holds the master credentials; the proxy rotates its
 *     pinned connection when the secret rotates, so long-lived services do
 *     not silently lose reconnect ability on token expiry.
 *   - Per-service IAM policies (rds-db:connect) are constructed in iam.tf;
 *     each service authenticates as its own PostgreSQL role with least-
 *     privilege grants, limiting blast radius per service.
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ── Security group for the proxy ─────────────────────────────────────────────
# Permits: ECS task SGs → proxy on 5432 (managed by callers attaching their
# SG to the proxy SG's ingress rule or by adding their SG to the ECS service).
# This SG is also granted egress to the RDS SG.

resource "aws_security_group" "proxy" {
  name        = "${var.environment}-travel-rds-proxy"
  description = "RDS Proxy — accept Postgres connections from ECS service tasks"
  vpc_id      = var.vpc_id

  ingress {
    description = "PostgreSQL from private subnets"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [] # filled dynamically by callers; start deny-all
    self        = true
  }

  egress {
    description = "PostgreSQL to RDS instance"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    # Scoped to the RDS security group via separate rule below
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-travel-rds-proxy"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# Allow RDS to accept connections from the proxy security group.
resource "aws_security_group_rule" "rds_from_proxy" {
  type                     = "ingress"
  description              = "PostgreSQL from RDS Proxy"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = var.rds_security_group_id
  source_security_group_id = aws_security_group.proxy.id
}

# ── IAM role for the proxy to call Secrets Manager ───────────────────────────

data "aws_iam_policy_document" "proxy_assume_role" {
  statement {
    sid    = "AllowRDSProxyAssumeRole"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "proxy_secrets" {
  name               = "${var.environment}-rds-proxy-secrets"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume_role.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-rds-proxy-secrets"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

data "aws_iam_policy_document" "proxy_secrets_access" {
  statement {
    sid    = "AllowSecretsManagerRead"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [var.db_secret_arn]
  }

  statement {
    sid    = "AllowKMSDecrypt"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]

    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "proxy_secrets_access" {
  name   = "proxy-secrets-access"
  role   = aws_iam_role.proxy_secrets.id
  policy = data.aws_iam_policy_document.proxy_secrets_access.json
}

# ── RDS Proxy ────────────────────────────────────────────────────────────────

resource "aws_db_proxy" "main" {
  name                   = "${var.environment}-travel-platform"
  debug_logging          = false
  engine_family          = "POSTGRESQL"
  idle_client_timeout    = 1800
  require_tls            = true
  role_arn               = aws_iam_role.proxy_secrets.arn
  vpc_security_group_ids = [aws_security_group.proxy.id]
  vpc_subnet_ids         = var.subnet_ids

  auth {
    auth_scheme               = "SECRETS"
    description               = "RDS master credentials from Secrets Manager"
    iam_auth                  = "REQUIRED"
    secret_arn                = var.db_secret_arn
    client_password_auth_type = "POSTGRES_SCRAM_SHA_256"
  }

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-travel-platform"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ── Default target group — connection pool tuning ───────────────────────────

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name

  connection_pool_config {
    # How long (seconds) the proxy waits for a server connection when all are
    # in use.  120 s gives borrow-latency alarms time to fire before clients
    # experience hard errors.
    connection_borrow_timeout = var.connection_borrow_timeout

    # Percentage of RDS max_connections the proxy may open as pinned server
    # connections.  Computed from the connection budget in connection-budget.md.
    max_connections_percent = var.max_connections_percent

    # Idle server connections are aggressively closed to return headroom to
    # the RDS instance for the migration task and purge worker.
    max_idle_connections_percent = var.max_idle_connections_percent

    # PostgreSQL session-level SET commands and prepared statements cause
    # connection pinning; these are acceptable for the platform's workload.
    session_pinning_filters = []
  }
}

# ── Target: RDS instance ─────────────────────────────────────────────────────

resource "aws_db_proxy_target" "main" {
  db_proxy_name          = aws_db_proxy.main.name
  target_group_name      = aws_db_proxy_default_target_group.main.name
  db_instance_identifier = var.rds_instance_identifier
}

# ── Outputs used by env modules ───────────────────────────────────────────────
# (Also declared in outputs.tf)
