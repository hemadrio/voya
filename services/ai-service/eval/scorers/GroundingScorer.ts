/**
 * GroundingScorer — asserts zero unsupported factual claims and traces
 * every offer card to the provenance ledger (WO-063, AC4).
 *
 * Detects unsupported claims by scanning emitted text for the replacement
 * markers inserted by ResponseAssembler when a claim is unsupported.
 * Verifies offer card traceability by matching emitted offer IDs against
 * the scenario's stubbed tool responses.
 */

import type { SinkEvent, OfferCardEvent } from "@travel/contracts";
import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

// Unsupported claim replacement markers (from ResponseAssembler)
const UNSUPPORTED_MARKERS = [
  "[price may vary",
  "[route details",
  "[time details",
  "[availability not confirmed",
] as const;

const GROUNDING_FALLBACK_MARKER = "I don't have current pricing or availability information";

export interface GroundingTurnScore {
  unsupportedClaims: number;
  offerCardsEmitted: number;
  offerCardsTraceable: number;
  pass: boolean;
}

export interface GroundingScoreResult {
  turns: GroundingTurnScore[];
  passRate: number;
  overallPass: boolean;
}

export class GroundingScorer {
  score(turns: TurnRunResult[], scenarioTurns: ScenarioTurn[]): GroundingScoreResult {
    const turnScores: GroundingTurnScore[] = turns.map((turn, i) => {
      const scenarioTurn = scenarioTurns[i];
      if (!scenarioTurn) return { unsupportedClaims: 0, offerCardsEmitted: 0, offerCardsTraceable: 0, pass: true };
      return this.scoreTurn(turn, scenarioTurn);
    });

    const passing = turnScores.filter((t) => t.pass).length;
    const passRate = turnScores.length > 0 ? passing / turnScores.length : 1;
    const minPassRate = scenarioTurns[0]?.expectations?.grounding?.minPassRate ?? 1.0;

    return {
      turns: turnScores,
      passRate,
      overallPass: passRate >= minPassRate,
    };
  }

  private scoreTurn(turn: TurnRunResult, scenarioTurn: ScenarioTurn): GroundingTurnScore {
    // Collect all emitted text
    const emittedText = turn.events
      .filter((e): e is SinkEvent & { type: "text_delta" } => e.type === "text_delta")
      .map((e) => (e as { type: "text_delta"; text: string }).text)
      .join("");

    // Count unsupported claim markers in emitted text
    let unsupportedClaims = 0;
    for (const marker of UNSUPPORTED_MARKERS) {
      const regex = new RegExp(marker.replace("[", "\\[").replace("]", "\\]"), "gi");
      const matches = emittedText.match(regex);
      unsupportedClaims += matches?.length ?? 0;
    }
    // Grounding fallback also counts
    if (emittedText.includes(GROUNDING_FALLBACK_MARKER)) unsupportedClaims++;

    // Count offer cards and check traceability
    const offerCardEvents = turn.events.filter(
      (e): e is OfferCardEvent => e.type === "offer_card",
    );
    const offerCardsEmitted = offerCardEvents.length;

    // An offer card is traceable if its offerId appears in any stubbed tool response data
    let offerCardsTraceable = 0;
    if (offerCardsEmitted > 0) {
      const allOfferIds = new Set<string>();
      for (const response of Object.values(scenarioTurn.stubbedToolResponses ?? {})) {
        if (response.ok && Array.isArray(response.data)) {
          for (const item of response.data as Array<{ id?: unknown }>) {
            if (typeof item?.id === "string") allOfferIds.add(item.id);
          }
        } else if (response.ok && response.data && typeof response.data === "object") {
          const id = (response.data as Record<string, unknown>)["id"];
          if (typeof id === "string") allOfferIds.add(id);
        }
      }
      offerCardsTraceable = offerCardEvents.filter((e) => allOfferIds.has(e.offerId)).length;
    }

    const expectations = scenarioTurn.expectations?.grounding;
    const allTraceable = expectations?.allOfferCardsTraceable ?? true;
    const traceabilityPass = !allTraceable || offerCardsEmitted === 0 || offerCardsTraceable === offerCardsEmitted;
    const pass = unsupportedClaims === 0 && traceabilityPass;

    return { unsupportedClaims, offerCardsEmitted, offerCardsTraceable, pass };
  }
}
