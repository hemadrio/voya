/**
 * Unit tests for TaskSuccessScorer (WO-063, AC11).
 */

import { describe, it, expect } from "vitest";
import { TaskSuccessScorer } from "../scorers/TaskSuccessScorer.js";
import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

function makeTurn(toolsDispatched: string[]): TurnRunResult {
  return {
    turnIndex: 0,
    events: [],
    firstEventMs: 10,
    totalMs: 50,
    tokensIn: 100,
    tokensOut: 20,
    toolsDispatched,
    wasRefused: false,
  };
}

function makeScenarioTurn(expectedTools?: string[]): ScenarioTurn {
  return {
    userContent: "test",
    stubbedToolResponses: {},
    scriptedModelTranscript: [[{ type: "message_end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }]],
    expectations: expectedTools ? { tools: expectedTools } : undefined,
  };
}

describe("TaskSuccessScorer", () => {
  it("reports 100% precision when all expected tools were dispatched", () => {
    const scorer = new TaskSuccessScorer();
    const result = scorer.score(
      [makeTurn(["search_flights"])],
      [makeScenarioTurn(["search_flights"])],
    );
    expect(result.turns[0]?.toolPrecision).toBe(1);
    expect(result.turns[0]?.pass).toBe(true);
  });

  it("reports 0% precision when no expected tools were dispatched", () => {
    const scorer = new TaskSuccessScorer();
    const result = scorer.score(
      [makeTurn([])],
      [makeScenarioTurn(["search_flights"])],
    );
    expect(result.turns[0]?.toolPrecision).toBe(0);
    expect(result.turns[0]?.pass).toBe(false);
  });

  it("reports partial precision for partial tool match", () => {
    const scorer = new TaskSuccessScorer();
    const result = scorer.score(
      [makeTurn(["search_flights"])],
      [makeScenarioTurn(["search_flights", "search_hotels"])],
    );
    expect(result.turns[0]?.toolPrecision).toBeCloseTo(0.5);
    expect(result.turns[0]?.pass).toBe(false);
  });

  it("passes when no expected tools are defined (any dispatch is ok)", () => {
    const scorer = new TaskSuccessScorer();
    const result = scorer.score(
      [makeTurn(["search_flights"])],
      [makeScenarioTurn()],
    );
    expect(result.turns[0]?.pass).toBe(true);
  });

  it("passes when no tools dispatched and none expected", () => {
    const scorer = new TaskSuccessScorer();
    const result = scorer.score(
      [makeTurn([])],
      [makeScenarioTurn([])],
    );
    expect(result.turns[0]?.toolPrecision).toBe(1);
    expect(result.turns[0]?.pass).toBe(true);
  });

  it("aggregates mean precision across multiple turns", () => {
    const scorer = new TaskSuccessScorer();
    const result = scorer.score(
      [makeTurn(["search_flights"]), makeTurn([])],
      [makeScenarioTurn(["search_flights"]), makeScenarioTurn(["search_hotels"])],
    );
    expect(result.meanToolPrecision).toBeCloseTo(0.5);
  });
});
