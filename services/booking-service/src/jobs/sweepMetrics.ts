/**
 * sweepMetrics.ts — CloudWatch EMF metric emission for the expiry sweep.
 *
 * Uses stdout-based EMF (Embedded Metric Format) which CloudWatch Logs
 * automatically parses — no AWS SDK call required, no IAM permission beyond
 * PutLogEvents, and no extra dependency.
 *
 * Metric names (namespace: travel/expiry-sweep):
 *   ExpiryCandidatesFound  - PENDING bookings found in the batch
 *   ExpiryExpiredCount     - successfully transitioned to EXPIRED
 *   ExpirySkippedCount     - skipped due to non-terminal PaymentIntent
 *   ExpiryFailedCount      - per-item errors
 *   ExpirySweepDurationMs  - total run wall-clock time
 */

export interface SweepMetricInput {
  candidates: number;
  expired: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

const NAMESPACE = "travel/expiry-sweep";

/**
 * Emit a single CloudWatch EMF log line to stdout.
 * CloudWatch Logs Agent / FireLens picks this up and publishes the metrics.
 */
export async function emitSweepMetrics(m: SweepMetricInput): Promise<void> {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [["Service"]],
          Metrics: [
            { Name: "ExpiryCandidatesFound", Unit: "Count" },
            { Name: "ExpiryExpiredCount",    Unit: "Count" },
            { Name: "ExpirySkippedCount",    Unit: "Count" },
            { Name: "ExpiryFailedCount",     Unit: "Count" },
            { Name: "ExpirySweepDurationMs", Unit: "Milliseconds" },
          ],
        },
      ],
    },
    Service:               "booking-service",
    ExpiryCandidatesFound: m.candidates,
    ExpiryExpiredCount:    m.expired,
    ExpirySkippedCount:    m.skipped,
    ExpiryFailedCount:     m.failed,
    ExpirySweepDurationMs: m.durationMs,
  };

  // Writing to stdout is synchronous; wrap in a promise for consistent async interface.
  process.stdout.write(JSON.stringify(emf) + "\n");
}
