/**
 * Unit tests for GroundingScorer (WO-063, AC11).
 */

import { describe, it, expect } from "vitest";
import { GroundingScorer } from "../scorers/GroundingScorer.js";
import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(overrides?: Partial<TurnRunResult>): TurnRunResult {
  return {
    turnIndex: 0,
    events: [],
    firstEventMs: 10,
    totalMs: 50,
    tokensIn: 100,
    tokensOut: 20,
    toolsDispatched: [],
    wasRefused: false,
    ...overrides,
  };
}

function makeScenarioTurn(overrides?: Partial<ScenarioTurn>): ScenarioTurn {
  return {
    userContent: "test",
    stubbedToolResponses: {},
    scriptedModelTranscript: [[{ type: "message_end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }]],
    ...overrides,
  };
}

function textDeltaEvent(text: string) {
  return { type: "text_delta" as const, text };
}

function offerCardEvent(offerId: string) {
  return {
    type: "offer_card" as const,
    offerId,
    provenance: "AMADEUS",
    tool: "search_flights",
    currency: "USD",
    price: 300,
    retrievedAt: Date.now(),
    stale: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GroundingScorer — clean response", () => {
  it("passes when no unsupported claim markers are present", () => {
    const scorer = new GroundingScorer();
    const turn = makeTurn({
      events: [textDeltaEvent("Here are some options for your trip.")],
    });
    const result = scorer.score([turn], [makeScenarioTurn()]);
    expect(result.turns[0]?.unsupportedClaims).toBe(0);
    expect(result.turns[0]?.pass).toBe(true);
    expect(result.overallPass).toBe(true);
  });
});

describe("GroundingScorer — unsupported claim detection", () => {
  it("counts price marker as an unsupported claim", () => {
    const scorer = new GroundingScorer();
    const turn = makeTurn({
      events: [textDeltaEvent("The fare is [price may vary — search for current rates] from this airline.")],
    });
    const result = scorer.score([turn], [makeScenarioTurn()]);
    expect(result.turns[0]?.unsupportedClaims).toBeGreaterThan(0);
    expect(result.turns[0]?.pass).toBe(false);
  });

  it("counts route marker as an unsupported claim", () => {
    const scorer = new GroundingScorer();
    const turn = makeTurn({
      events: [textDeltaEvent("Fly [route details — search for options] for the best connection.")],
    });
    const result = scorer.score([turn], [makeScenarioTurn()]);
    expect(result.turns[0]?.unsupportedClaims).toBeGreaterThan(0);
    expect(result.turns[0]?.pass).toBe(false);
  });

  it("counts grounding fallback message as unsupported", () => {
    const scorer = new GroundingScorer();
    const turn = makeTurn({
      events: [textDeltaEvent("I don't have current pricing or availability information to share. Please use the search above.")],
    });
    const result = scorer.score([turn], [makeScenarioTurn()]);
    expect(result.turns[0]?.unsupportedClaims).toBeGreaterThan(0);
  });

  it("passes with zero claims", () => {
    const scorer = new GroundingScorer();
    const turn = makeTurn({ events: [] });
    const result = scorer.score([turn], [makeScenarioTurn()]);
    expect(result.overallPass).toBe(true);
  });
});

describe("GroundingScorer — offer card traceability", () => {
  it("passes when emitted offer ID exists in stubbed responses", () => {
    const scorer = new GroundingScorer();
    const turn = makeTurn({
      events: [offerCardEvent("FL001")],
    });
    const scenarioTurn = makeScenarioTurn({
      stubbedToolResponses: {
        "search_flights:0": {
          ok: true,
          data: [{ id: "FL001", price: 489, currency: "USD" }],
        },
      },
      expectations: { grounding: { allOfferCardsTraceable: true } },
    });
    const result = scorer.score([turn], [scenarioTurn]);
    expect(result.turns[0]?.offerCardsTraceable).toBe(1);
    expect(result.turns[0]?.pass).toBe(true);
  });

  it("fails when emitted offer ID does not exist in stubbed responses", () => {
    const scorer = new GroundingScorer();
    const turn = makeTurn({
      events: [offerCardEvent("FABRICATED-ID")],
    });
    const scenarioTurn = makeScenarioTurn({
      stubbedToolResponses: {
        "search_flights:0": {
          ok: true,
          data: [{ id: "FL001", price: 489, currency: "USD" }],
        },
      },
      expectations: { grounding: { allOfferCardsTraceable: true } },
    });
    const result = scorer.score([turn], [scenarioTurn]);
    expect(result.turns[0]?.offerCardsTraceable).toBe(0);
    expect(result.turns[0]?.pass).toBe(false);
  });
});

describe("GroundingScorer — pass rate aggregation", () => {
  it("computes pass rate across multiple turns", () => {
    const scorer = new GroundingScorer();
    const cleanTurn = makeTurn({ events: [textDeltaEvent("Safe text.")] });
    const dirtyTurn = makeTurn({ events: [textDeltaEvent("[price may vary — search for current rates]")] });
    const result = scorer.score([cleanTurn, dirtyTurn], [makeScenarioTurn(), makeScenarioTurn()]);
    expect(result.passRate).toBeCloseTo(0.5);
    expect(result.overallPass).toBe(false);
  });
});
