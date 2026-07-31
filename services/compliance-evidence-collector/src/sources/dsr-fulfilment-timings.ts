/**
 * DsrFulfilmentTimings — data subject request fulfilment timings.
 *
 * Counts outstanding requests, checks for any that exceed the 30-day GDPR window,
 * and records the oldest outstanding request age in days.
 *
 * No subject identifiers in the evidence — counts and timings only.
 */

import type { EvidenceSource, EvidenceResult } from "../types.js";
import { EvidenceSourceError } from "../types.js";

export interface DsrTimingDeps {
  fetchOutstandingRequests(asOf: Date): Promise<Array<{
    requestId: string;
    type: string;
    requestedAt: string;
    ageInDays: number;
  }>>;
  fetchCompletedRequests(date: Date): Promise<Array<{
    requestId: string;
    type: string;
    fulfilledInDays: number;
  }>>;
}

const GDPR_WINDOW_DAYS = 30;

export class DsrFulfilmentTimings implements EvidenceSource {
  readonly name = "dsr_fulfilment_timings";

  constructor(private readonly deps: DsrTimingDeps) {}

  async gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult> {
    try {
      const [outstanding, completed] = await Promise.all([
        this.deps.fetchOutstandingRequests(date),
        this.deps.fetchCompletedRequests(date),
      ]);

      const breaches = outstanding.filter((r) => r.ageInDays >= GDPR_WINDOW_DAYS);
      const oldestAgeInDays = outstanding.length > 0
        ? Math.max(...outstanding.map((r) => r.ageInDays))
        : 0;

      return {
        kind: "evidence",
        controlId, controlGroup,
        evidenceSource: this.name,
        collectedAt: new Date().toISOString(),
        runId,
        period: { date: date.toISOString().slice(0, 10) },
        data: {
          outstandingCount: outstanding.length,
          completedTodayCount: completed.length,
          gdprWindowBreachCount: breaches.length,
          oldestOutstandingAgeInDays: oldestAgeInDays,
          gdprWindowDays: GDPR_WINDOW_DAYS,
          breachingRequestIds: breaches.map((r) => r.requestId),
          typeCounts: countByType([...outstanding, ...completed]),
        },
      };
    } catch (err) {
      throw new EvidenceSourceError(controlId, "dsr_timings_failed", err);
    }
  }
}

function countByType(items: Array<{ type: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}
