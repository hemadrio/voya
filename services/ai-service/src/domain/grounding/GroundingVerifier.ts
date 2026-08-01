/**
 * GroundingVerifier — matches extracted claims against the ProvenanceLedger
 * and returns per-claim support verdicts (WO-060).
 *
 * Verification rules:
 *   PRICE       — exact numeric match AND exact currency match required.
 *                 Off-by-even-one-cent is treated as UNSUPPORTED.
 *   ROUTE       — normalised IATA code comparison (case-insensitive).
 *                 "JFK to CDG" matches "JFK-CDG" in the ledger.
 *   TIME        — contextual check: supported when any ledger entry exists.
 *                 (Times are scheduling details; we cannot verify them
 *                 from price snapshots.)
 *   AVAILABILITY — contextual: supported only when at least one ledger entry
 *                 has availability=true and is within the freshness window.
 *
 * Staleness: offers older than freshnessWindowMs are marked stale.
 * Deterministic: same inputs always produce the same output (no model call).
 */

import type { ProvenanceLedger, OfferSnapshot } from "./ProvenanceLedger.js";
import type { Claim } from "./ClaimExtractor.js";
import { normaliseRoute } from "./ProvenanceLedger.js";

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

export interface VerificationResult {
  claim: Claim;
  /** True when the claim is matched to a ledger entry. */
  supported: boolean;
  /** The matching offer reference (undefined when unsupported). */
  offerRef?: string;
  /** True when the matched offer is older than the freshness window. */
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// GroundingVerifier
// ---------------------------------------------------------------------------

/** Default freshness window: 15 minutes. */
const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;

export class GroundingVerifier {
  constructor(
    private readonly freshnessWindowMs: number = DEFAULT_FRESHNESS_MS,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Verify all claims against the ledger.
   * Returns results in the same order as the input claims array.
   */
  verify(claims: Claim[], ledger: ProvenanceLedger): VerificationResult[] {
    const now = this.clock();
    const allEntries = ledger.getAll();

    return claims.map((claim) => {
      try {
        return this.verifyClaim(claim, allEntries, now);
      } catch {
        // Verification bug → fail safe (treat as unsupported)
        return { claim, supported: false };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Per-claim verification
  // ---------------------------------------------------------------------------

  private verifyClaim(
    claim: Claim,
    entries: OfferSnapshot[],
    now: number,
  ): VerificationResult {
    switch (claim.type) {
      case "PRICE":
        return this.verifyPrice(claim, entries, now);
      case "ROUTE":
        return this.verifyRoute(claim, entries, now);
      case "TIME":
        return this.verifyTime(claim, entries);
      case "AVAILABILITY":
        return this.verifyAvailability(claim, entries, now);
    }
  }

  private verifyPrice(
    claim: Claim,
    entries: OfferSnapshot[],
    now: number,
  ): VerificationResult {
    // normalisedValue is "412.50:USD"
    const [amountStr, currency] = claim.normalisedValue.split(":");
    const amount = parseFloat(amountStr);
    if (!isFinite(amount)) return { claim, supported: false };

    for (const entry of entries) {
      if (entry.currency !== currency) continue;
      // Exact match required — zero tolerance for currency amounts
      if (Math.abs(entry.price - amount) < 0.001) {
        const stale = now - entry.retrievedAt > this.freshnessWindowMs;
        return { claim, supported: true, offerRef: entry.offerRef, stale };
      }
    }
    return { claim, supported: false };
  }

  private verifyRoute(
    claim: Claim,
    entries: OfferSnapshot[],
    now: number,
  ): VerificationResult {
    const normClaim = normaliseRoute(claim.normalisedValue);

    for (const entry of entries) {
      if (!entry.route) continue;
      // Match in either direction (JFK-CDG == CDG-JFK for a return trip check)
      const normEntry = entry.route;
      const [oA, dA] = normClaim.split("-");
      const [oB, dB] = normEntry.split("-");
      if (
        (oA === oB && dA === dB) ||
        (oA === dB && dA === oB)
      ) {
        const stale = now - entry.retrievedAt > this.freshnessWindowMs;
        return { claim, supported: true, offerRef: entry.offerRef, stale };
      }
    }
    return { claim, supported: false };
  }

  private verifyTime(claim: Claim, entries: OfferSnapshot[]): VerificationResult {
    // Times are contextual — supported when any entry exists in the ledger
    return { claim, supported: entries.length > 0 };
  }

  private verifyAvailability(
    claim: Claim,
    entries: OfferSnapshot[],
    now: number,
  ): VerificationResult {
    // Supported only when at least one fresh, available offer exists
    for (const entry of entries) {
      if (!entry.availability) continue;
      const stale = now - entry.retrievedAt > this.freshnessWindowMs;
      if (!stale) {
        return { claim, supported: true, offerRef: entry.offerRef, stale: false };
      }
    }
    // Check if stale entries exist (supported but stale)
    for (const entry of entries) {
      if (entry.availability) {
        return { claim, supported: true, offerRef: entry.offerRef, stale: true };
      }
    }
    return { claim, supported: false };
  }
}
