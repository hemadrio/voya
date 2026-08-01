/**
 * CostScorer — reports token usage and tool call counts per scenario (WO-063, AC7).
 */

import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

export interface CostTurnScore {
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  withinBounds: boolean;
}

export interface CostScoreResult {
  turns: CostTurnScore[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  meanTokensIn: number;
  meanTokensOut: number;
  overallPass: boolean;
}

export class CostScorer {
  score(turns: TurnRunResult[], scenarioTurns: ScenarioTurn[]): CostScoreResult {
    const turnScores: CostTurnScore[] = turns.map((turn, i) => {
      const scenarioTurn = scenarioTurns[i];
      if (!scenarioTurn) return { tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, toolCalls: turn.toolsDispatched.length, withinBounds: true };
      return this.scoreTurn(turn, scenarioTurn);
    });

    const totalTokensIn = turnScores.reduce((s, t) => s + t.tokensIn, 0);
    const totalTokensOut = turnScores.reduce((s, t) => s + t.tokensOut, 0);
    const totalToolCalls = turnScores.reduce((s, t) => s + t.toolCalls, 0);
    const n = turnScores.length || 1;

    return {
      turns: turnScores,
      totalTokensIn,
      totalTokensOut,
      totalToolCalls,
      meanTokensIn: totalTokensIn / n,
      meanTokensOut: totalTokensOut / n,
      overallPass: turnScores.every((t) => t.withinBounds),
    };
  }

  private scoreTurn(turn: TurnRunResult, scenarioTurn: ScenarioTurn): CostTurnScore {
    const toolCalls = turn.toolsDispatched.length;
    const costExp = scenarioTurn.expectations?.cost;

    const withinBounds =
      (costExp?.maxTokensIn === undefined || turn.tokensIn <= costExp.maxTokensIn) &&
      (costExp?.maxTokensOut === undefined || turn.tokensOut <= costExp.maxTokensOut) &&
      (costExp?.maxToolCalls === undefined || toolCalls <= costExp.maxToolCalls);

    return { tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, toolCalls, withinBounds };
  }
}
