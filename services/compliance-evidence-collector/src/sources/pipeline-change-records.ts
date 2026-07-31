/**
 * PipelineChangeRecords — deployment and change approval records from CI/CD.
 *
 * Reads from the Forge pipeline artifact store or a pipeline-events table.
 * Evidence: deploymentsCount, approvedCount, unapprovedDeploymentIds (IDs only, not details).
 */

import type { EvidenceSource, EvidenceResult } from "../types.js";
import { EvidenceSourceError } from "../types.js";

export interface PipelineRecord {
  deploymentId: string;
  environment: string;
  approvedBy: string | null;   // approver ID (internal UUID, not email)
  deployedAt: string;
  gitSha: string;
  outcome: "success" | "failed" | "rolled_back";
}

export interface PipelineChangeRecordsDeps {
  fetchDeployments(date: Date): Promise<PipelineRecord[]>;
}

export class PipelineChangeRecords implements EvidenceSource {
  readonly name = "pipeline_change_records";

  constructor(private readonly deps: PipelineChangeRecordsDeps) {}

  async gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult> {
    try {
      const records = await this.deps.fetchDeployments(date);

      if (records.length === 0) {
        return {
          kind: "gap",
          controlId, controlGroup,
          evidenceSource: this.name,
          collectedAt: new Date().toISOString(),
          runId,
          period: { date: date.toISOString().slice(0, 10) },
          reason: "no_data",
        };
      }

      const unapproved = records.filter((r) => !r.approvedBy).map((r) => r.deploymentId);

      return {
        kind: "evidence",
        controlId, controlGroup,
        evidenceSource: this.name,
        collectedAt: new Date().toISOString(),
        runId,
        period: { date: date.toISOString().slice(0, 10) },
        data: {
          deploymentsCount: records.length,
          approvedCount: records.length - unapproved.length,
          unapprovedDeploymentIds: unapproved,
          failedDeploymentCount: records.filter((r) => r.outcome === "failed").length,
          rolledBackCount: records.filter((r) => r.outcome === "rolled_back").length,
        },
      };
    } catch (err) {
      throw new EvidenceSourceError(controlId, "pipeline_records_failed", err);
    }
  }
}
