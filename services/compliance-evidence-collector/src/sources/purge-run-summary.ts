/**
 * PurgeRunSummary — captures retention purge worker outcomes.
 *
 * Reads purge_run_events from a metrics store or structured log.
 * Evidence: rowsPurged per category, errors, durationMs.
 */

import type { EvidenceSource, EvidenceResult } from "../types.js";
import { EvidenceSourceError } from "../types.js";

export interface PurgeRunEvent {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  categoryResults: Array<{ category: string; rowsPurged: number; errors: number }>;
  totalRowsPurged: number;
  totalErrors: number;
}

export interface PurgeRunSummaryDeps {
  fetchRunsForDate(date: Date): Promise<PurgeRunEvent[]>;
}

export class PurgeRunSummary implements EvidenceSource {
  readonly name = "purge_run_summary";

  constructor(private readonly deps: PurgeRunSummaryDeps) {}

  async gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult> {
    try {
      const runs = await this.deps.fetchRunsForDate(date);

      if (runs.length === 0) {
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

      const latest = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

      return {
        kind: "evidence",
        controlId, controlGroup,
        evidenceSource: this.name,
        collectedAt: new Date().toISOString(),
        runId,
        period: { date: date.toISOString().slice(0, 10) },
        data: {
          runsCount: runs.length,
          latestRunId: latest.runId,
          latestRunDurationMs: latest.durationMs,
          latestRunTotalRowsPurged: latest.totalRowsPurged,
          latestRunTotalErrors: latest.totalErrors,
          categoryResults: latest.categoryResults,
        },
      };
    } catch (err) {
      throw new EvidenceSourceError(controlId, "purge_summary_failed", err);
    }
  }
}
