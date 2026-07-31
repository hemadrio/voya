/**
 * Custom CloudWatch EMF metric helpers for compliance and operational controls.
 *
 * Each function emits a structured log line in CloudWatch Embedded Metric Format
 * (EMF). The ADOT sidecar parses these and publishes them as CloudWatch metrics
 * without a separate PutMetricData API call.
 *
 * Namespaces:
 *   travel/audit       — audit write failures, chain verification
 *   travel/compliance  — evidence collection, DSR fulfilment
 *   travel/purge       — purge run outcomes (mirrors retention_worker)
 *   travel/payment     — reconciliation exceptions
 *   travel/security    — webhook sig failures, access-control denials, illustrative exposures
 *
 * PII policy: no function accepts or emits email addresses, card numbers,
 * subject identifiers, or secret values.
 */

// ---------------------------------------------------------------------------
// EMF helpers
// ---------------------------------------------------------------------------

/** Emit a CloudWatch EMF structured log line to stdout. */
function emitEmf(namespace: string, metrics: Record<string, number>, dimensions: Record<string, string> = {}): void {
  const metricDefs = Object.keys(metrics).map((name) => ({ Name: name, Unit: "Count" }));
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [Object.keys(dimensions)],
          Metrics: metricDefs,
        },
      ],
    },
    ...dimensions,
    ...metrics,
  };
  process.stdout.write(JSON.stringify(emf) + "\n");
}

// ---------------------------------------------------------------------------
// Audit metrics
// ---------------------------------------------------------------------------

/** Increment when an audit write fails. Each failure is a control breach. */
export function recordAuditWriteFailure(environment: string): void {
  emitEmf("travel/audit", { audit_write_failures_total: 1 }, { environment });
}

/** Increment when a hash-chain break is detected. */
export function recordAuditChainBreak(environment: string, controlId: string): void {
  emitEmf("travel/audit", { audit_chain_breaks_total: 1 }, { environment, control_id: controlId });
}

// ---------------------------------------------------------------------------
// Compliance / evidence collection metrics
// ---------------------------------------------------------------------------

/** Emitted once per collector run as a heartbeat. Absence triggers the evidence-gap alarm. */
export function recordEvidenceCollectorHeartbeat(environment: string, runId: string): void {
  emitEmf("travel/compliance", { evidence_collector_heartbeat: 1 }, { environment, run_id: runId });
}

/** Increment when an evidence source produces a gap (no data or failure). */
export function recordEvidenceGap(environment: string, controlId: string, reason: string): void {
  emitEmf("travel/compliance", { evidence_gaps_total: 1 }, { environment, control_id: controlId, reason });
}

/** Increment when a collector run completes successfully. */
export function recordEvidenceRunCompleted(environment: string, collectedCount: number, gapCount: number): void {
  emitEmf("travel/compliance", {
    evidence_artefacts_collected_total: collectedCount,
    evidence_gaps_in_run_total: gapCount,
    evidence_runs_completed_total: 1,
  }, { environment });
}

// ---------------------------------------------------------------------------
// DSR fulfilment metrics
// ---------------------------------------------------------------------------

/** Record the count of DSR requests that breached the 30-day GDPR window. */
export function recordDsrWindowBreaches(environment: string, count: number): void {
  emitEmf("travel/compliance", { dsr_gdpr_window_breaches_total: count }, { environment });
}

// ---------------------------------------------------------------------------
// Purge metrics (complement retention_worker's own metrics)
// ---------------------------------------------------------------------------

/** Record that a purge run completed with errors. */
export function recordPurgeRunFailure(environment: string, categoryErrors: number): void {
  emitEmf("travel/purge", { purge_run_failures_total: 1, purge_category_errors: categoryErrors }, { environment });
}

// ---------------------------------------------------------------------------
// Payment reconciliation metrics
// ---------------------------------------------------------------------------

/** Record the count of unreconciled payments at daily close. Zero is the SLO target. */
export function recordPaymentReconciliationExceptions(environment: string, count: number): void {
  emitEmf("travel/payment", { payment_reconciliation_exceptions_total: count }, { environment });
}

// ---------------------------------------------------------------------------
// Security metrics
// ---------------------------------------------------------------------------

/** Increment when a webhook HMAC signature verification fails. */
export function recordWebhookSignatureFailure(environment: string, provider: string): void {
  emitEmf("travel/security", { webhook_signature_failures_total: 1 }, { environment, provider });
}

/** Increment when an access-control check denies a request. */
export function recordAccessControlDenial(environment: string, route: string): void {
  emitEmf("travel/security", { access_control_denials_total: 1 }, { environment, route });
}

/** Increment when an illustrative search result is exposed (target: zero in production). */
export function recordIllustrativeResultExposure(environment: string): void {
  emitEmf("travel/security", { illustrative_result_exposures_total: 1 }, { environment });
}
