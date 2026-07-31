/**
 * PaymentReconciliation — daily payment reconciliation exception count.
 *
 * Objective O3: zero unreconciled payments at daily close.
 * Evidence: exceptionCount, settledCount, period.
 * No booking IDs or payment references with PII — counts only.
 */

import type { EvidenceSource, EvidenceResult } from "../types.js";
import { EvidenceSourceError } from "../types.js";

export interface ReconciliationResult {
  settledCount: number;
  confirmedBookingsCount: number;
  exceptionCount: number;
  exceptionBookingIds: string[];   // internal UUIDs only, not PII
  periodDate: string;
}

export interface PaymentReconciliationDeps {
  reconcile(date: Date): Promise<ReconciliationResult>;
}

export class PaymentReconciliation implements EvidenceSource {
  readonly name = "payment_reconciliation";

  constructor(private readonly deps: PaymentReconciliationDeps) {}

  async gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult> {
    try {
      const result = await this.deps.reconcile(date);

      return {
        kind: "evidence",
        controlId, controlGroup,
        evidenceSource: this.name,
        collectedAt: new Date().toISOString(),
        runId,
        period: { date: date.toISOString().slice(0, 10) },
        data: {
          settledPaymentsCount: result.settledCount,
          confirmedBookingsCount: result.confirmedBookingsCount,
          exceptionCount: result.exceptionCount,
          exceptionBookingIds: result.exceptionBookingIds,
          allReconciled: result.exceptionCount === 0,
          objectiveO3Met: result.exceptionCount === 0,
        },
      };
    } catch (err) {
      throw new EvidenceSourceError(controlId, "payment_reconciliation_failed", err);
    }
  }
}
