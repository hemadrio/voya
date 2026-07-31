/**
 * ScanResults — dependency vulnerability (SCA) and secret scan outcomes.
 *
 * Evidence: critical/high CVE counts, secret scan pass/fail, scan tool versions.
 * No CVE descriptions, no secret values — counts only.
 */

import type { EvidenceSource, EvidenceResult } from "../types.js";
import { EvidenceSourceError } from "../types.js";

export interface ScanSummary {
  scanType: "sca" | "secret";
  toolVersion: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  passed: boolean;
  scannedAt: string;
}

export interface ScanResultsDeps {
  fetchScanSummaries(date: Date): Promise<ScanSummary[]>;
}

export class ScanResults implements EvidenceSource {
  readonly name = "scan_results";

  constructor(private readonly deps: ScanResultsDeps) {}

  async gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult> {
    try {
      const summaries = await this.deps.fetchScanSummaries(date);

      if (summaries.length === 0) {
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

      return {
        kind: "evidence",
        controlId, controlGroup,
        evidenceSource: this.name,
        collectedAt: new Date().toISOString(),
        runId,
        period: { date: date.toISOString().slice(0, 10) },
        data: {
          scans: summaries,
          allPassed: summaries.every((s) => s.passed),
          criticalCveTotal: summaries.reduce((a, s) => a + s.critical, 0),
          highCveTotal: summaries.reduce((a, s) => a + s.high, 0),
        },
      };
    } catch (err) {
      throw new EvidenceSourceError(controlId, "scan_results_failed", err);
    }
  }
}
