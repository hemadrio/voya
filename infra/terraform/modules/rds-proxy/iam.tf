/**
 * Per-service IAM policies for RDS Proxy IAM authentication.
 *
 * Each service (and each operational role) receives an isolated
 * rds-db:connect policy scoped to exactly its own proxy + db-user
 * combination.  This limits blast radius: a compromised service task role
 * can only authenticate as that service's database user, not as any other
 * service or as the master user.
 *
 * The policies are OUTPUTS not attachments — they are attached in the
 * ecs-service module (task_role) when the service opts in via the
 * rds_connect_policy_arn variable.  This preserves the ecs-service module
 * as the single attachment point and avoids cross-module resource references
 * that couple modules together.
 *
 * rds-db:connect ARN format:
 *   arn:aws:rds-db:<region>:<account>:dbuser:<proxy-resource-id>/<db-user>
 */

# ── Per-service policies ──────────────────────────────────────────────────────

data "aws_iam_policy_document" "service_rds_connect" {
  for_each = var.db_service_users

  statement {
    sid    = "AllowRDSProxyConnect"
    effect = "Allow"

    actions = ["rds-db:connect"]

    # Scope: exactly this proxy + this service's DB user.
    # A service cannot impersonate another service's database role.
    resources = [
      "arn:aws:rds-db:${var.aws_region}:${var.aws_account_id}:dbuser:${aws_db_proxy.main.id}/${each.value}"
    ]
  }
}

resource "aws_iam_policy" "service_rds_connect" {
  for_each = var.db_service_users

  name        = "${var.environment}-${each.key}-rds-connect"
  description = "Allows ${each.key} ECS task role to authenticate to RDS Proxy as DB user '${each.value}' via IAM auth."
  policy      = data.aws_iam_policy_document.service_rds_connect[each.key].json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-${each.key}-rds-connect"
    Environment = var.environment
    Service     = each.key
    ManagedBy   = "terraform"
  })
}

# ── Migration task policy ─────────────────────────────────────────────────────

data "aws_iam_policy_document" "migration_rds_connect" {
  statement {
    sid    = "AllowMigrationConnect"
    effect = "Allow"
    actions = ["rds-db:connect"]
    resources = [
      "arn:aws:rds-db:${var.aws_region}:${var.aws_account_id}:dbuser:${aws_db_proxy.main.id}/${var.migration_db_user}"
    ]
  }
}

resource "aws_iam_policy" "migration_rds_connect" {
  name        = "${var.environment}-migration-task-rds-connect"
  description = "Allows the one-off migration ECS task to authenticate to RDS Proxy as '${var.migration_db_user}'."
  policy      = data.aws_iam_policy_document.migration_rds_connect.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-migration-task-rds-connect"
    Environment = var.environment
    Role        = "migration-task"
    ManagedBy   = "terraform"
  })
}

# ── Purge worker policy ───────────────────────────────────────────────────────

data "aws_iam_policy_document" "purge_worker_rds_connect" {
  statement {
    sid    = "AllowPurgeWorkerConnect"
    effect = "Allow"
    actions = ["rds-db:connect"]
    resources = [
      "arn:aws:rds-db:${var.aws_region}:${var.aws_account_id}:dbuser:${aws_db_proxy.main.id}/${var.purge_worker_db_user}"
    ]
  }
}

resource "aws_iam_policy" "purge_worker_rds_connect" {
  name        = "${var.environment}-purge-worker-rds-connect"
  description = "Allows the scheduled purge worker to authenticate to RDS Proxy as '${var.purge_worker_db_user}'."
  policy      = data.aws_iam_policy_document.purge_worker_rds_connect.json

  tags = merge(var.common_tags, {
    Name        = "${var.environment}-purge-worker-rds-connect"
    Environment = var.environment
    Role        = "purge-worker"
    ManagedBy   = "terraform"
  })
}
