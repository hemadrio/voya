/**
 * compliance-alarms.tf — CloudWatch alarms for SOC 2 compliance controls.
 *
 * All alarms are defined in infrastructure-as-code (IaC) so alarm drift is
 * visible in pull requests (AC4 constraint).
 *
 * Namespaces:
 *   travel/audit      — audit write failure, chain break
 *   travel/compliance — evidence gap, DSR window breach
 *   travel/purge      — purge failures (also in monitoring.tf for booking alarms)
 *   travel/payment    — reconciliation exceptions
 *   travel/security   — webhook sig failures, access-control denials, illustrative exposures
 *
 * All alarms route to oncall_sns_topic_arn (defined in monitoring.tf).
 * Severity is encoded in the alarm name prefix: CRITICAL / HIGH / MEDIUM.
 *
 * Runbooks: docs/runbooks/<alarm-name>.md linked from alarm_description.
 */

locals {
  compliance_namespace = "travel/compliance"
  audit_namespace      = "travel/audit"
  security_namespace   = "travel/security"
  payment_namespace    = "travel/payment"

  runbook_base_url = "https://github.com/your-org/travel-platform/blob/main/docs/runbooks"
}

# ---------------------------------------------------------------------------
# Audit write failure
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "audit_write_failure" {
  alarm_name          = "CRITICAL-audit-write-failure"
  alarm_description   = "Audit write failure detected. Every failure is a control breach. Immediate investigation required. Runbook: ${local.runbook_base_url}/audit-write-failure.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "audit_write_failures_total"
  namespace           = local.audit_namespace
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Audit hash-chain break
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "audit_chain_break" {
  alarm_name          = "CRITICAL-audit-chain-break"
  alarm_description   = "Audit log hash-chain integrity break detected. This may indicate unauthorised mutation of the immutable audit record. Isolate and investigate immediately. Runbook: ${local.runbook_base_url}/audit-chain-break.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "audit_chain_breaks_total"
  namespace           = local.audit_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Purge job failure (compliance-specific — complements monitoring.tf)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "purge_run_failure_compliance" {
  alarm_name          = "HIGH-purge-run-failure-compliance"
  alarm_description   = "Retention purge run reported category-level failures. Data lifecycle compliance is at risk. Runbook: ${local.runbook_base_url}/purge-run-failure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "purge_run_failures_total"
  namespace           = "travel/purge"
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Illustrative result exposure
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "illustrative_result_exposure" {
  alarm_name          = "CRITICAL-illustrative-result-exposure"
  alarm_description   = "An illustrative (non-bookable) search result was exposed in production without an approved audit-logged feature flag. Target: exactly zero. Runbook: ${local.runbook_base_url}/illustrative-result-exposure.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "illustrative_result_exposures_total"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Webhook signature verification failure spike
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "webhook_signature_failure_spike" {
  alarm_name          = "HIGH-webhook-signature-failure-spike"
  alarm_description   = "Webhook HMAC signature verification failures are elevated (>=5 in 5 minutes). Possible replay attack or misconfigured Stripe webhook secret. Runbook: ${local.runbook_base_url}/webhook-signature-failure.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "webhook_signature_failures_total"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Access-control denial spike
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "access_control_denial_spike" {
  alarm_name          = "HIGH-access-control-denial-spike"
  alarm_description   = "Access-control denials (403) exceeded threshold (>=50 in 5 minutes). Possible credential stuffing, brute-force, or misconfiguration. Runbook: ${local.runbook_base_url}/access-control-denial-spike.md"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "access_control_denials_total"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 50
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Evidence collection gap (heartbeat absence)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "evidence_collection_gap" {
  alarm_name          = "HIGH-evidence-collection-gap"
  alarm_description   = "Evidence collector heartbeat absent for >25 hours. This means a control evidence gap exists in the SOC 2 observation window. Investigate EventBridge schedule and ECS task health. Runbook: ${local.runbook_base_url}/evidence-collection-gap.md"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "evidence_collector_heartbeat"
  namespace           = local.compliance_namespace
  period              = 90000   # 25 hours
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# DSR GDPR window breach
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dsr_gdpr_window_breach" {
  alarm_name          = "CRITICAL-dsr-gdpr-window-breach"
  alarm_description   = "One or more data subject requests have exceeded the 30-day GDPR fulfilment window. Regulatory obligation at risk. Runbook: ${local.runbook_base_url}/dsr-gdpr-window-breach.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "dsr_gdpr_window_breaches_total"
  namespace           = local.compliance_namespace
  period              = 86400   # daily check
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Payment reconciliation exception (Objective O3)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "payment_reconciliation_exception" {
  alarm_name          = "CRITICAL-payment-reconciliation-exception"
  alarm_description   = "Daily payment reconciliation has non-zero exceptions. Objective O3 requires zero unreconciled payments at daily close. Finance and Engineering must investigate. Runbook: ${local.runbook_base_url}/payment-reconciliation-exception.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "payment_reconciliation_exceptions_total"
  namespace           = local.payment_namespace
  period              = 86400
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
