/**
 * ResponseAssembler — rewrites unsupported claims, builds grounded offer cards,
 * and returns grounding references (WO-060).
 *
 * Core anti-hallucination contract:
 *   - Offer card fields are ALWAYS sourced from the ProvenanceLedger snapshot.
 *   - Offer cards are NEVER constructed from model-generated text.
 *   - Unsupported factual claims are removed or softened, never corrected with
 *     invented values.
 *
 * Rewriting is deterministic and idempotent: same input → same output always.
 * This enables golden-file regression tests.
 *
 * When ALL claims in a turn are unsupported (or no offers were retrieved), a
 * safe fallback message is emitted rather than an empty or hallucinated response.
 */

import type { ProvenanceLedger, OfferSnapshot } from "./ProvenanceLedger.js";
import type { VerificationResult } from "./GroundingVerifier.js";
import type { ClaimType } from "./ClaimExtractor.js";

// ---------------------------------------------------------------------------
// Safe fallback message (emitted when all claims are unsupported or no offers)
// ---------------------------------------------------------------------------

export const GROUNDING_FALLBACK_MESSAGE =
  "I don't have current pricing or availability information to share. " +
  "Please use the search above to find live options for your trip.";

// Wording suppressed when an availability claim is stale
const STALE_AVAILABILITY_NOTICE =
  " (Note: availability information may be outdated — please search again to confirm.)";

// ---------------------------------------------------------------------------
// Replacement text for each unsupported claim type
// ---------------------------------------------------------------------------

const UNSUPPORTED_REPLACEMENTS: Record<ClaimType, string> = {
  PRICE: "[price may vary — search for current rates]",
  ROUTE: "[route details — search for options]",
  TIME: "[time details — search to confirm]",
  AVAILABILITY: "[availability not confirmed — search to verify]",
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface GroundedOfferCard {
  offerRef: string;
  tool: string;
  supplier: string;
  retrievedAt: number;
  stale: boolean;
  price: number;
  currency: string;
  route?: string;
  property?: string;
  availability: boolean;
  displayTitle?: string;
  displaySummary?: string;
}

export interface GroundingRef {
  offerRef: string;
  tool: string;
  supplier: string;
  retrievedAt: number;
  price: number;
  currency: string;
}

export interface StrippedClaim {
  type: ClaimType;
  rawText: string;
  reason: "unsupported" | "stale";
}

export interface AssemblyResult {
  /** The rewritten text safe to emit to the client. */
  safeText: string;
  /** Offer cards built exclusively from ledger snapshots. */
  offerCards: GroundedOfferCard[];
  /** References to persist with the turn (for audit). */
  groundingRefs: GroundingRef[];
  /** Details of stripped/rewritten claims (for metrics). */
  strippedClaims: StrippedClaim[];
  /** True when the safeText is the fallback message (all claims unsupported). */
  usedFallback: boolean;
}

// ---------------------------------------------------------------------------
// ResponseAssembler
// ---------------------------------------------------------------------------

export class ResponseAssembler {
  constructor(private readonly freshnessWindowMs: number = 15 * 60 * 1000) {}

  /**
   * Assemble the final grounded turn output.
   *
   * @param text        Raw accumulated model text.
   * @param verdicts    Per-claim verification results from GroundingVerifier.
   * @param ledger      The per-turn provenance ledger.
   * @param now         Current epoch ms (injected for determinism).
   */
  assemble(
    text: string,
    verdicts: VerificationResult[],
    ledger: ProvenanceLedger,
    now: number,
  ): AssemblyResult {
    const strippedClaims: StrippedClaim[] = [];

    // -----------------------------------------------------------------------
    // Step 1: Rewrite unsupported / stale claim spans in the text
    // -----------------------------------------------------------------------
    const safeText = this.rewriteText(text, verdicts, strippedClaims);

    // -----------------------------------------------------------------------
    // Step 2: Build offer cards from ledger snapshots
    //         Cards are only emitted for offers that are matched by at least
    //         one supported claim, OR for all offers if no claim was made but
    //         offers exist (pure tool-result turn).
    // -----------------------------------------------------------------------
    const referencedOfferRefs = new Set<string>(
      verdicts
        .filter((v) => v.supported && v.offerRef)
        .map((v) => v.offerRef as string),
    );

    // If no claims reference specific offers, emit all ledger offers
    const offerRefsToEmit =
      referencedOfferRefs.size > 0 ? referencedOfferRefs : new Set(ledger.getAll().map((e) => e.offerRef));

    const offerCards: GroundedOfferCard[] = [];
    const groundingRefs: GroundingRef[] = [];

    for (const offerRef of offerRefsToEmit) {
      const snapshot = ledger.get(offerRef);
      if (!snapshot) continue; // Fabricated reference — silently drop

      const stale = now - snapshot.retrievedAt > this.freshnessWindowMs;
      offerCards.push(snapshotToCard(snapshot, stale));
      groundingRefs.push(snapshotToRef(snapshot));
    }

    // -----------------------------------------------------------------------
    // Step 3: Fallback message when all claims were unsupported or no text
    //         remains after stripping
    // -----------------------------------------------------------------------
    const hasNoUsableText =
      safeText.trim().length === 0 ||
      (strippedClaims.length > 0 && verdicts.length > 0 && verdicts.every((v) => !v.supported));

    const isEmptyLedger = ledger.isEmpty && verdicts.length === 0;
    const allClaimsUnsupported =
      verdicts.length > 0 && verdicts.every((v) => !v.supported);

    const usedFallback = hasNoUsableText || (allClaimsUnsupported && offerCards.length === 0) || isEmptyLedger && safeText.trim().length === 0;

    return {
      safeText: usedFallback ? GROUNDING_FALLBACK_MESSAGE : safeText,
      offerCards,
      groundingRefs,
      strippedClaims,
      usedFallback,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: text rewriting
  // ---------------------------------------------------------------------------

  private rewriteText(
    text: string,
    verdicts: VerificationResult[],
    strippedClaims: StrippedClaim[],
  ): string {
    if (verdicts.length === 0) return text;

    // Work backwards through claims (reverse span order) so earlier offsets
    // are not invalidated when we replace later spans
    const sorted = [...verdicts].sort(
      (a, b) => b.claim.span.end - a.claim.span.end,
    );

    let result = text;
    for (const verdict of sorted) {
      const { claim, supported, stale } = verdict;

      if (!supported) {
        // Replace unsupported span with non-committal placeholder
        result =
          result.slice(0, claim.span.start) +
          UNSUPPORTED_REPLACEMENTS[claim.type] +
          result.slice(claim.span.end);
        strippedClaims.push({ type: claim.type, rawText: claim.rawText, reason: "unsupported" });
      } else if (stale && claim.type === "AVAILABILITY") {
        // Append stale notice after the claim (don't remove it)
        result =
          result.slice(0, claim.span.end) +
          STALE_AVAILABILITY_NOTICE +
          result.slice(claim.span.end);
        strippedClaims.push({ type: claim.type, rawText: claim.rawText, reason: "stale" });
      }
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snapshotToCard(snapshot: OfferSnapshot, stale: boolean): GroundedOfferCard {
  return {
    offerRef: snapshot.offerRef,
    tool: snapshot.tool,
    supplier: snapshot.supplier,
    retrievedAt: snapshot.retrievedAt,
    stale,
    price: snapshot.price,
    currency: snapshot.currency,
    route: snapshot.route,
    property: snapshot.property,
    availability: snapshot.availability,
    displayTitle: snapshot.displayTitle,
    displaySummary: snapshot.displaySummary,
  };
}

function snapshotToRef(snapshot: OfferSnapshot): GroundingRef {
  return {
    offerRef: snapshot.offerRef,
    tool: snapshot.tool,
    supplier: snapshot.supplier,
    retrievedAt: snapshot.retrievedAt,
    price: snapshot.price,
    currency: snapshot.currency,
  };
}
