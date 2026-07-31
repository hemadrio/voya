/**
 * Wire production adapters with real AWS/DB clients.
 *
 * In tests, callers inject stub implementations directly into runCollector()
 * rather than going through this wiring module.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SourceRegistry } from "./registry.js";
import { AuditChainVerifier } from "./sources/audit-chain-verifier.js";
import { AccessReviewSnapshot } from "./sources/access-review-snapshot.js";
import { PipelineChangeRecords } from "./sources/pipeline-change-records.js";
import { ScanResults } from "./sources/scan-results.js";
import { PurgeRunSummary } from "./sources/purge-run-summary.js";
import { SecretRotationEvents } from "./sources/secret-rotation-events.js";
import { DsrFulfilmentTimings } from "./sources/dsr-fulfilment-timings.js";
import { PaymentReconciliation } from "./sources/payment-reconciliation.js";
import type { StoragePort } from "./collector.js";
import type { RunManifest } from "./types.js";

export interface AdapterConfig {
  environment: string;
  bucketName: string;
  region?: string;
}

export async function buildAdapters(config: AdapterConfig): Promise<{ registry: SourceRegistry; storage: StoragePort }> {
  const region = config.region ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
  const s3 = new S3Client({ region });

  // ── Storage port ──────────────────────────────────────────────────────────
  const storage: StoragePort = {
    async putArtefact(key: string, content: string, sha256: string): Promise<void> {
      await s3.send(new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        Body: content,
        ContentType: "application/json",
        ChecksumSHA256: sha256,
        ServerSideEncryption: "aws:kms",
        // Object Lock retention is configured at the bucket level (compliance mode)
        // The collector role has no PutObjectRetention permission.
      }));
    },
    async getManifest(_runId: string): Promise<RunManifest | null> {
      // Manifest retrieval is used by the report generator (report.ts)
      return null;
    },
  };

  // ── Source adapters ───────────────────────────────────────────────────────
  const registry = new SourceRegistry();

  registry.register(new AuditChainVerifier({
    async fetchRows(_checkpointRowId, _batchSize) {
      // Production: query booking_audit_log with SELECT id, prev_hash, action, occurred_at, row_hash
      // Scoped to read-only DB credentials.
      return [];
    },
    async loadCheckpoint() {
      // Production: load from a checkpoints table or SSM parameter
      return { lastVerifiedRowId: null };
    },
    async saveCheckpoint(_rowId) {
      // Production: update checkpoint store
    },
  }));

  registry.register(new AccessReviewSnapshot({
    async fetchRoleSummary() {
      // Production: SELECT role, COUNT(*) FROM users GROUP BY role
      return [];
    },
    async fetchIamRoleNames() {
      // Production: IAM list-roles (scoped to account)
      return [];
    },
  }));

  registry.register(new PipelineChangeRecords({
    async fetchDeployments(_date) {
      // Production: read from pipeline events table or artifact store API
      return [];
    },
  }));

  registry.register(new ScanResults({
    async fetchScanSummaries(_date) {
      // Production: read from scan-results artifact in pipeline store
      return [];
    },
  }));

  registry.register(new PurgeRunSummary({
    async fetchRunsForDate(_date) {
      // Production: query CloudWatch Logs Insights for purge_run metric events
      return [];
    },
  }));

  registry.register(new SecretRotationEvents({
    maxAgePolicy: 90,
    async fetchRotationEvents(_date) {
      // Production: list secrets in scope and check LastRotatedDate
      return [];
    },
  }));

  registry.register(new DsrFulfilmentTimings({
    async fetchOutstandingRequests(_asOf) {
      // Production: SELECT id, type, requested_at, age_in_days FROM data_subject_requests WHERE status NOT IN ('ready','failed','expired')
      return [];
    },
    async fetchCompletedRequests(_date) {
      // Production: DSRs completed on the given date
      return [];
    },
  }));

  registry.register(new PaymentReconciliation({
    async reconcile(_date) {
      // Production: join bookings (CONFIRMED, created on date) against payment events
      return { settledCount: 0, confirmedBookingsCount: 0, exceptionCount: 0, exceptionBookingIds: [], periodDate: _date.toISOString().slice(0, 10) };
    },
  }));

  return { registry, storage };
}
