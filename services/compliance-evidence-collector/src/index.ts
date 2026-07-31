/**
 * Compliance evidence collector — entry point.
 *
 * Triggered by EventBridge on a daily schedule. Runs once, collects all
 * control evidence, writes artefacts to S3, and exits.
 *
 * Exit codes:
 *   0  — all evidence collected (or planned gaps only)
 *   1  — one or more source failures recorded as gap artefacts
 *   2  — matrix validation error (aborts before any write)
 */

import { loadControlMatrix, validateAdapters } from "./matrix.js";
import { SourceRegistry } from "./registry.js";
import { runCollector } from "./collector.js";
import { AuditChainVerifier } from "./sources/audit-chain-verifier.js";
import { AccessReviewSnapshot } from "./sources/access-review-snapshot.js";
import { PipelineChangeRecords } from "./sources/pipeline-change-records.js";
import { ScanResults } from "./sources/scan-results.js";
import { PurgeRunSummary } from "./sources/purge-run-summary.js";
import { SecretRotationEvents } from "./sources/secret-rotation-events.js";
import { DsrFulfilmentTimings } from "./sources/dsr-fulfilment-timings.js";
import { PaymentReconciliation } from "./sources/payment-reconciliation.js";
import { buildAdapters } from "./adapters.js";

const MATRIX_PATH = process.env["CONTROL_MATRIX_PATH"] ?? "../../docs/compliance/control-matrix.yaml";
const ENVIRONMENT = process.env["ENVIRONMENT"] ?? "development";
const EVIDENCE_BUCKET = process.env["EVIDENCE_BUCKET"] ?? "";

async function main(): Promise<void> {
  // 1. Load and validate the control matrix
  let matrix;
  try {
    matrix = loadControlMatrix(MATRIX_PATH);
  } catch (err) {
    process.stderr.write(`[compliance-collector] MATRIX ERROR: ${String(err)}\n`);
    process.exit(2);
  }

  // 2. Build adapters with real infrastructure dependencies
  const { registry, storage } = await buildAdapters({ environment: ENVIRONMENT, bucketName: EVIDENCE_BUCKET });

  // 3. Validate that every non-planned control has an adapter
  try {
    validateAdapters(matrix, registry.registeredNames());
  } catch (err) {
    process.stderr.write(`[compliance-collector] ADAPTER DRIFT: ${String(err)}\n`);
    process.exit(2);
  }

  // 4. Run the collector
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0); // normalise to midnight UTC

  const result = await runCollector({ environment: ENVIRONMENT, date, matrix, registry, storage });

  process.stdout.write(JSON.stringify({
    event: "compliance.collector.completed",
    runId: result.runId,
    date: date.toISOString().slice(0, 10),
    collected: result.manifest.totals.collected,
    gaps: result.manifest.totals.gaps,
    planned: result.manifest.totals.planned,
    failures: result.manifest.totals.failures,
  }) + "\n");

  process.exit(result.hadFailures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`[compliance-collector] FATAL: ${String(err)}\n`);
  process.exit(1);
});
