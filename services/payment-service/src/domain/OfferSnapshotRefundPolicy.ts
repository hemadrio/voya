/**
 * OfferSnapshotRefundPolicy — derives refund eligibility from supplier terms
 * stored in the booking offer_snapshot (WO-049 AC6).
 *
 * The offer snapshot is frozen at booking creation time and carries the
 * supplier's terms for each leg.  This adapter reads the snapshot and returns
 * an EligibilityDecision without making any network call.
 *
 * Default: non-refundable when no terms are present.
 *
 * Snapshot shape expected (from the booking service WO-039):
 *   {
 *     legs?: Array<{
 *       legId: string;
 *       supplierTerms?: {
 *         refundable: boolean;
 *         penaltyMinor?: number;    // minor units, integer
 *         penaltyCurrency?: string;
 *         windowDays?: number;
 *         termRef?: string;         // supplier term identifier surfaced in 422 errors
 *       };
 *     }>;
 *     supplierTerms?: {             // booking-level terms (no legs)
 *       refundable: boolean;
 *       penaltyMinor?: number;
 *       penaltyCurrency?: string;
 *       windowDays?: number;
 *       termRef?: string;
 *     };
 *   }
 */

import type { EligibilityDecision, RefundPolicyPort } from "./RefundService.js";

// ---------------------------------------------------------------------------
// Snapshot shape (loose — validated at booking creation by booking-service)
// ---------------------------------------------------------------------------

interface SupplierTerms {
  refundable?: boolean;
  penaltyMinor?: number;
  penaltyCurrency?: string;
  windowDays?: number;
  termRef?: string;
}

interface SnapshotLeg {
  legId?: string;
  supplierTerms?: SupplierTerms;
}

interface OfferSnapshot {
  legs?: SnapshotLeg[];
  supplierTerms?: SupplierTerms;
}

// ---------------------------------------------------------------------------
// OfferSnapshotRefundPolicy
// ---------------------------------------------------------------------------

export class OfferSnapshotRefundPolicy implements RefundPolicyPort {
  async checkEligibility(
    offerSnapshot: unknown,
    chargeAmountMinor: bigint,
    currency: string,
    legId?: string,
  ): Promise<EligibilityDecision> {
    const snapshot = offerSnapshot as OfferSnapshot | null | undefined;

    if (!snapshot || typeof snapshot !== "object") {
      // No snapshot — default to non-refundable
      return {
        eligible: false,
        refundableAmountMinor: BigInt(0),
        currency,
        supplierTermRef: "no_terms_available",
      };
    }

    // If a specific leg is requested, look up that leg's terms
    if (legId !== undefined) {
      const leg = snapshot.legs?.find((l) => l.legId === legId);
      if (!leg) {
        return {
          eligible: false,
          refundableAmountMinor: BigInt(0),
          currency,
          supplierTermRef: "leg_not_found",
        };
      }
      return resolveTerms(leg.supplierTerms, chargeAmountMinor, currency);
    }

    // No legId — use booking-level terms or the first leg's terms
    const terms = snapshot.supplierTerms ?? snapshot.legs?.[0]?.supplierTerms;
    return resolveTerms(terms, chargeAmountMinor, currency);
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function resolveTerms(
  terms: SupplierTerms | undefined,
  chargeAmountMinor: bigint,
  currency: string,
): EligibilityDecision {
  if (!terms) {
    return {
      eligible: false,
      refundableAmountMinor: BigInt(0),
      currency,
      supplierTermRef: "no_terms_available",
    };
  }

  if (!terms.refundable) {
    return {
      eligible: false,
      refundableAmountMinor: BigInt(0),
      currency,
      supplierTermRef: terms.termRef ?? "non_refundable",
    };
  }

  // Compute refundable amount: charge minus any penalty (integer minor units)
  const penaltyMinor =
    terms.penaltyMinor !== undefined ? BigInt(Math.trunc(terms.penaltyMinor)) : BigInt(0);
  const refundableAmountMinor =
    chargeAmountMinor > penaltyMinor ? chargeAmountMinor - penaltyMinor : BigInt(0);

  return {
    eligible: refundableAmountMinor > BigInt(0),
    refundableAmountMinor,
    currency,
    supplierTermRef: terms.termRef,
  };
}
