/**
 * Unit tests for LatencyScorer (WO-063, AC11).
 */

import { describe, it, expect } from "vitest";
import { LatencyScorer } from "../scorers/LatencyScorer.js";
import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

function makeTurn(firstEventMs: number, totalMs: number): TurnRunResult {
  return {
    turnIndex: 0,
    events: [],
    firstEventMs,
    totalMs,
    tokensIn: 100,
    tokensOut: 20,
    toolsDispatched: [],
    wasRefused: false,
  };
}

function makeScenarioTurn(latencyBounds?: { maxFirstEventMs?: number; maxTotalMs?: number }): ScenarioTurn {
  return {
    userContent: "test",
    stubbedToolResponses: {},
    scriptedModelTranscript: [[{ type: "message_end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }]],
    expectations: latencyBounds ? { latency: latencyBounds } : undefined,
  };
}

describe("LatencyScorer", () => {
  it("passes when latency is within bounds", () => {
    const scorer = new LatencyScorer();
    const result = scorer.score(
      [makeTurn(20, 80)],
      [makeScenarioTurn({ maxFirstEventMs: 100, maxTotalMs: 200 })],
    );
    expect(result.turns[0]?.withinBounds).toBe(true);
    expect(result.overallPass).toBe(true);
  });

  it("fails when firstEventMs exceeds bound", () => {
    const scorer = new LatencyScorer();
    const result = scorer.score(
      [makeTurn(150, 200)],
      [makeScenarioTurn({ maxFirstEventMs: 100 })],
    );
    expect(result.turns[0]?.withinBounds).toBe(false);
    expect(result.overallPass).toBe(false);
  });

  it("fails when totalMs exceeds bound", () => {
    const scorer = new LatencyScorer();
    const result = scorer.score(
      [makeTurn(10, 500)],
      [makeScenarioTurn({ maxTotalMs: 200 })],
    );
    expect(result.turns[0]?.withinBounds).toBe(false);
  });

  it("passes when no latency bounds are defined", () => {
    const scorer = new LatencyScorer();
    const result = scorer.score(
      [makeTurn(10000, 999999)],
      [makeScenarioTurn()],
    );
    expect(result.turns[0]?.withinBounds).toBe(true);
  });

  it("computes p95 correctly for multiple turns", () => {
    const scorer = new LatencyScorer();
    const turns = Array.from({ length: 20 }, (_, i) =>
      makeTurn(10, (i + 1) * 10),
    );
    const scenarioTurns = turns.map(() => makeScenarioTurn());
    const result = scorer.score(turns, scenarioTurns);
    // p95 of [10,20,...,200] — sorted, index floor(20*0.95) = floor(19) = 19 → value 200
    expect(result.p95TotalMs).toBe(200);
  });

  it("computes mean correctly", () => {
    const scorer = new LatencyScorer();
    const result = scorer.score(
      [makeTurn(10, 100), makeTurn(20, 200)],
      [makeScenarioTurn(), makeScenarioTurn()],
    );
    expect(result.meanTotalMs).toBe(150);
  });
});
