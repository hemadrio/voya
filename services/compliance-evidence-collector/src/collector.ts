/**
 * CollectorOrchestrator — iterates the control matrix, gathers evidence,
 * writes artefacts, and produces the run manifest.
 *
 * Each control is processed independently. A failure in one adapter records
 * a gap artefact for that control and increments the failure metric but does
 * NOT abort the run — the orchestrator continues to maximise evidence coverage.
 * The run exits non-zero if any source failure occurred (AC error handling).
 */

import { randomUUID } from "node:crypto";
import { buildS3Key, serialiseArtefact, buildManifest } from "./artefact.js";
import {
  recordEvidenceCollectorHeartbeat,
  recordEvidenceGap,
  recordEvidenceRunCompleted,
  recordAuditChainBreak,
  recordPurgeRunFailure,
  recordPaymentReconciliationExceptions,
  recordDsrWindowBreaches,
} from "@travel/observability";
import type {
  EvidenceResult,
  GapRecord,
  ManifestEntry,
  ControlEntry,
} from "./types.js";
import { EvidenceSourceError } from "./types.js";
import type { SourceRegistry } from "./registry.js";
import type { ControlMatrix } from "./types.js";
import type { RunManifest } from "./types.js";

export interface StoragePort {
  /**
   * Write an artefact to the evidence bucket.
   * Throws on S3 write failure (caller retries).
   */
  putArtefact(key: string, content: string, sha256: string): Promise<void>;
  /** Read a manifest by run ID (for report generation). */
  getManifest(runId: string): Promise<RunManifest | null>;
}

export interface CollectorOptions {
  environment: string;
  date: Date;
  matrix: ControlMatrix;
  registry: SourceRegistry;
  storage: StoragePort;
}

export interface CollectorResult {
  runId: string;
  manifest: RunManifest;
  hadFailures: boolean;
}

export async function runCollector(opts: CollectorOptions): Promise<CollectorResult> {
  const { environment, date, matrix, registry, storage } = opts;
  const runId = randomUUID();
  const runStartedAt = new Date();

  recordEvidenceCollectorHeartbeat(environment, runId);

  const entries: ManifestEntry[] = [];
  const gaps: GapRecord[] = [];
  let hadFailures = false;

  for (const control of matrix.controls) {
    const result = await gatherOne(control, registry, date, runId, environment);

    if (result.kind === "evidence") {
      const key = buildS3Key({
        environment,
        controlGroup: control.group,
        date,
        controlId: control.id,
        runId,
      });
      const { content, sha256, sizeBytes } = serialiseArtefact(result);
      await storage.putArtefact(key, content, sha256);

      entries.push({
        controlId: control.id,
        controlGroup: control.group,
        s3Key: key,
        sha256,
        collectedAt: result.collectedAt,
        sizeBytes,
      });

      // Emit secondary metrics from evidence data
      emitSecondaryMetrics(result, environment);

    } else {
      gaps.push(result);
      if (result.reason === "source_failure") {
        hadFailures = true;
        recordEvidenceGap(environment, control.id, "source_failure");
      } else {
        recordEvidenceGap(environment, control.id, result.reason);
      }
    }
  }

  const runCompletedAt = new Date();
  const manifest = buildManifest({
    runId,
    environment,
    runStartedAt,
    runCompletedAt,
    date,
    entries,
    gaps,
  });

  // Write manifest to a well-known key
  const manifestKey = `${environment}/manifests/${date.toISOString().slice(0, 10)}/${runId}-manifest.json`;
  const { content: manifestContent, sha256: manifestSha } = serialiseArtefact({
    kind: "evidence",
    controlId: "manifest",
    controlGroup: "META",
    evidenceSource: "collector",
    collectedAt: runCompletedAt.toISOString(),
    runId,
    period: { date: date.toISOString().slice(0, 10) },
    data: manifest as unknown as Record<string, unknown>,
  });
  await storage.putArtefact(manifestKey, manifestContent, manifestSha);

  recordEvidenceRunCompleted(environment, entries.length, gaps.filter((g) => g.reason !== "planned").length);

  return { runId, manifest, hadFailures };
}

async function gatherOne(
  control: ControlEntry,
  registry: SourceRegistry,
  date: Date,
  runId: string,
  environment: string,
): Promise<EvidenceResult> {
  // Planned controls produce an explicit planned gap — not a failure
  if (control.status === "planned") {
    return {
      kind: "gap",
      controlId: control.id,
      controlGroup: control.group,
      evidenceSource: control.evidence_source,
      collectedAt: new Date().toISOString(),
      runId,
      period: { date: date.toISOString().slice(0, 10) },
      reason: "planned",
    };
  }

  const adapter = registry.get(control.evidence_source);
  if (!adapter) {
    // This should have been caught by validateAdapters() before the run starts
    return {
      kind: "gap",
      controlId: control.id,
      controlGroup: control.group,
      evidenceSource: control.evidence_source,
      collectedAt: new Date().toISOString(),
      runId,
      period: { date: date.toISOString().slice(0, 10) },
      reason: "source_failure",
      errorClass: "AdapterNotFound",
      referenceId: runId,
    };
  }

  try {
    return await adapter.gather(date, runId, control.id, control.group);
  } catch (err) {
    const isSourceErr = err instanceof EvidenceSourceError;
    return {
      kind: "gap",
      controlId: control.id,
      controlGroup: control.group,
      evidenceSource: control.evidence_source,
      collectedAt: new Date().toISOString(),
      runId,
      period: { date: date.toISOString().slice(0, 10) },
      reason: "source_failure",
      errorClass: isSourceErr ? err.reason : "UnknownError",
      referenceId: runId,
    };
  }
}

function emitSecondaryMetrics(result: EvidenceResult, environment: string): void {
  if (result.kind !== "evidence") return;
  const data = result.data;

  if (result.evidenceSource === "audit_chain_verifier" && data["chainOk"] === false) {
    recordAuditChainBreak(environment, result.controlId);
  }
  if (result.evidenceSource === "purge_run_summary" && (data["latestRunTotalErrors"] as number) > 0) {
    recordPurgeRunFailure(environment, data["latestRunTotalErrors"] as number);
  }
  if (result.evidenceSource === "payment_reconciliation") {
    recordPaymentReconciliationExceptions(environment, (data["exceptionCount"] as number) ?? 0);
  }
  if (result.evidenceSource === "dsr_fulfilment_timings") {
    recordDsrWindowBreaches(environment, (data["gdprWindowBreachCount"] as number) ?? 0);
  }
}
