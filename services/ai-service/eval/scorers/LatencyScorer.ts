/**
 * LatencyScorer — derives simulated first-event and total turn durations from
 * the deterministic clock (WO-063, AC7).
 *
 * Uses the injected clock's values from the runner — gate is stable regardless
 * of CI runner hardware.
 */

import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

export interface LatencyTurnScore {
  firstEventMs: number;
  totalMs: number;
  withinBounds: boolean;
}

export interface LatencyScoreResult {
  turns: LatencyTurnScore[];
  meanTotalMs: number;
  p95TotalMs: number;
  overallPass: boolean;
}

export class LatencyScorer {
  score(turns: TurnRunResult[], scenarioTurns: ScenarioTurn[]): LatencyScoreResult {
    const turnScores: LatencyTurnScore[] = turns.map((turn, i) => {
      const scenarioTurn = scenarioTurns[i];
      if (!scenarioTurn) return { firstEventMs: turn.firstEventMs, totalMs: turn.totalMs, withinBounds: true };
      return this.scoreTurn(turn, scenarioTurn);
    });

    const totalMs = turnScores.map((t) => t.totalMs).sort((a, b) => a - b);
    const n = totalMs.length || 1;
    const meanTotalMs = totalMs.reduce((s, v) => s + v, 0) / n;
    const p95TotalMs = totalMs[Math.floor(n * 0.95)] ?? totalMs[n - 1] ?? 0;

    return {
      turns: turnScores,
      meanTotalMs,
      p95TotalMs,
      overallPass: turnScores.every((t) => t.withinBounds),
    };
  }

  private scoreTurn(turn: TurnRunResult, scenarioTurn: ScenarioTurn): LatencyTurnScore {
    const latencyExp = scenarioTurn.expectations?.latency;
    const withinBounds =
      (latencyExp?.maxFirstEventMs === undefined || turn.firstEventMs <= latencyExp.maxFirstEventMs) &&
      (latencyExp?.maxTotalMs === undefined || turn.totalMs <= latencyExp.maxTotalMs);

    return { firstEventMs: turn.firstEventMs, totalMs: turn.totalMs, withinBounds };
  }
}
