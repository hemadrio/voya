/**
 * compliance-dashboard.tf — CloudWatch compliance dashboard.
 *
 * One dashboard showing control health per group with:
 *   - Evidence freshness (time since last successful artefact)
 *   - Open gap count
 *   - Alarm state widgets for every compliance alarm
 *
 * Reachable by the Compliance and Risk Lead without production data access
 * (CloudWatch read-only IAM policy, no PII in metrics).
 */

resource "aws_cloudwatch_dashboard" "compliance" {
  dashboard_name = "${var.environment}-soc2-compliance"

  dashboard_body = jsonencode({
    widgets = [
      # ── Title ──────────────────────────────────────────────────────────────
      {
        type   = "text"
        x      = 0; y = 0; width = 24; height = 2
        properties = {
          markdown = "# SOC 2 Compliance Dashboard — ${upper(var.environment)}\nControl evidence freshness and alarm state. Last updated: auto-refresh every 5 minutes."
        }
      },

      # ── Evidence collector heartbeat ──────────────────────────────────────
      {
        type   = "metric"
        x      = 0; y = 2; width = 6; height = 4
        properties = {
          title  = "Evidence Collector Heartbeat (25h)"
          view   = "singleValue"
          period = 90000
          metrics = [[
            "travel/compliance", "evidence_collector_heartbeat",
            { "stat" = "Sum", "label" = "Runs" }
          ]]
        }
      },

      # ── Evidence artefacts vs gaps ─────────────────────────────────────────
      {
        type   = "metric"
        x      = 6; y = 2; width = 10; height = 4
        properties = {
          title  = "Evidence Artefacts Collected vs Gaps (7d)"
          view   = "timeSeries"
          period = 86400
          metrics = [
            ["travel/compliance", "evidence_artefacts_collected_total", { "stat" = "Sum", "label" = "Artefacts" }],
            ["travel/compliance", "evidence_gaps_in_run_total", { "stat" = "Sum", "label" = "Gaps", "color" = "#d62728" }]
          ]
        }
      },

      # ── Alarm state: CRITICAL alarms ──────────────────────────────────────
      {
        type   = "alarm"
        x      = 0; y = 6; width = 24; height = 3
        properties = {
          title  = "CRITICAL Compliance Alarms"
          alarms = [
            aws_cloudwatch_metric_alarm.audit_write_failure.arn,
            aws_cloudwatch_metric_alarm.audit_chain_break.arn,
            aws_cloudwatch_metric_alarm.illustrative_result_exposure.arn,
            aws_cloudwatch_metric_alarm.dsr_gdpr_window_breach.arn,
            aws_cloudwatch_metric_alarm.payment_reconciliation_exception.arn,
          ]
        }
      },

      # ── Alarm state: HIGH alarms ──────────────────────────────────────────
      {
        type   = "alarm"
        x      = 0; y = 9; width = 24; height = 3
        properties = {
          title  = "HIGH Compliance Alarms"
          alarms = [
            aws_cloudwatch_metric_alarm.webhook_signature_failure_spike.arn,
            aws_cloudwatch_metric_alarm.access_control_denial_spike.arn,
            aws_cloudwatch_metric_alarm.evidence_collection_gap.arn,
            aws_cloudwatch_metric_alarm.purge_run_failure_compliance.arn,
          ]
        }
      },

      # ── CC6: Logical Access ───────────────────────────────────────────────
      {
        type   = "metric"
        x      = 0; y = 12; width = 8; height = 4
        properties = {
          title  = "CC6: Audit Chain Breaks (7d)"
          view   = "timeSeries"
          period = 86400
          metrics = [[
            "travel/audit", "audit_chain_breaks_total",
            { "stat" = "Sum", "label" = "Chain Breaks", "color" = "#d62728" }
          ]]
        }
      },

      {
        type   = "metric"
        x      = 8; y = 12; width = 8; height = 4
        properties = {
          title  = "CC6: DSR GDPR Window Breaches (30d)"
          view   = "timeSeries"
          period = 86400
          metrics = [[
            "travel/compliance", "dsr_gdpr_window_breaches_total",
            { "stat" = "Sum", "label" = "Breaches", "color" = "#d62728" }
          ]]
        }
      },

      # ── CC7: System Operations ─────────────────────────────────────────────
      {
        type   = "metric"
        x      = 0; y = 16; width = 8; height = 4
        properties = {
          title  = "CC7: Purge Run Failures (7d)"
          view   = "timeSeries"
          period = 86400
          metrics = [[
            "travel/purge", "purge_run_failures_total",
            { "stat" = "Sum", "label" = "Failures", "color" = "#d62728" }
          ]]
        }
      },

      # ── CC7: Payment Reconciliation (Objective O3) ────────────────────────
      {
        type   = "metric"
        x      = 8; y = 16; width = 8; height = 4
        properties = {
          title  = "CC7: Payment Reconciliation Exceptions (O3 — target: 0)"
          view   = "timeSeries"
          period = 86400
          metrics = [[
            "travel/payment", "payment_reconciliation_exceptions_total",
            { "stat" = "Sum", "label" = "Exceptions", "color" = "#d62728" }
          ]]
        }
      },

      # ── Security metrics ──────────────────────────────────────────────────
      {
        type   = "metric"
        x      = 0; y = 20; width = 12; height = 4
        properties = {
          title  = "Security: Webhook Signature Failures (24h)"
          view   = "timeSeries"
          period = 300
          metrics = [[
            "travel/security", "webhook_signature_failures_total",
            { "stat" = "Sum", "label" = "Sig Failures" }
          ]]
        }
      },

      {
        type   = "metric"
        x      = 12; y = 20; width = 12; height = 4
        properties = {
          title  = "Security: Access Control Denials (24h)"
          view   = "timeSeries"
          period = 300
          metrics = [[
            "travel/security", "access_control_denials_total",
            { "stat" = "Sum", "label" = "Denials" }
          ]]
        }
      },
    ]
  })
}

output "compliance_dashboard_url" {
  value       = "https://console.aws.amazon.com/cloudwatch/home#dashboards:name=${aws_cloudwatch_dashboard.compliance.dashboard_name}"
  description = "URL of the SOC 2 compliance dashboard in CloudWatch."
}
