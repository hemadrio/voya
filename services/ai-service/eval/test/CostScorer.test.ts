/**
 * Unit tests for CostScorer (WO-063, AC11).
 */

import { describe, it, expect } from "vitest";
import { CostScorer } from "../scorers/CostScorer.js";
import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

function makeTurn(tokensIn: number, tokensOut: number, toolCalls: number): TurnRunResult {
  return {
    turnIndex: 0,
    events: [],
    firstEventMs: 10,
    totalMs: 50,
    tokensIn,
    tokensOut,
    toolsDispatched: Array.from({ length: toolCalls }, (_, i) => `tool${i}`),
    wasRefused: false,
  };
}

function makeScenarioTurn(costBounds?: { maxTokensIn?: number; maxTokensOut?: number; maxToolCalls?: number }): ScenarioTurn {
  return {
    userContent: "test",
    stubbedToolResponses: {},
    scriptedModelTranscript: [[{ type: "message_end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }]],
    expectations: costBounds ? { cost: costBounds } : undefined,
  };
}

describe("CostScorer", () => {
  it("passes when tokens are within bounds", () => {
    const scorer = new CostScorer();
    const result = scorer.score(
      [makeTurn(100, 20, 1)],
      [makeScenarioTurn({ maxTokensIn: 200, maxTokensOut: 50 })],
    );
    expect(result.turns[0]?.withinBounds).toBe(true);
    expect(result.overallPass).toBe(true);
  });

  it("fails when tokensIn exceeds bound", () => {
    const scorer = new CostScorer();
    const result = scorer.score(
      [makeTurn(300, 20, 1)],
      [makeScenarioTurn({ maxTokensIn: 200 })],
    );
    expect(result.turns[0]?.withinBounds).toBe(false);
    expect(result.overallPass).toBe(false);
  });

  it("fails when tokensOut exceeds bound", () => {
    const scorer = new CostScorer();
    const result = scorer.score(
      [makeTurn(100, 100, 1)],
      [makeScenarioTurn({ maxTokensOut: 50 })],
    );
    expect(result.turns[0]?.withinBounds).toBe(false);
  });

  it("fails when tool calls exceed bound", () => {
    const scorer = new CostScorer();
    const result = scorer.score(
      [makeTurn(100, 20, 5)],
      [makeScenarioTurn({ maxToolCalls: 2 })],
    );
    expect(result.turns[0]?.withinBounds).toBe(false);
  });

  it("passes when no cost bounds are defined", () => {
    const scorer = new CostScorer();
    const result = scorer.score(
      [makeTurn(5000, 2000, 20)],
      [makeScenarioTurn()],
    );
    expect(result.turns[0]?.withinBounds).toBe(true);
  });

  it("aggregates totals correctly", () => {
    const scorer = new CostScorer();
    const result = scorer.score(
      [makeTurn(100, 20, 1), makeTurn(200, 40, 2)],
      [makeScenarioTurn(), makeScenarioTurn()],
    );
    expect(result.totalTokensIn).toBe(300);
    expect(result.totalTokensOut).toBe(60);
    expect(result.totalToolCalls).toBe(3);
    expect(result.meanTokensIn).toBe(150);
  });
});
