/**
 * TaskSuccessScorer — compares dispatched tools and extracted slots against
 * scenario expectations (WO-063, AC6).
 */

import type { TurnRunResult } from "../runner.js";
import type { ScenarioTurn } from "../schema.js";

export interface TaskSuccessTurnScore {
  expectedTools: string[];
  dispatchedTools: string[];
  /** Fraction of expected tools that were dispatched. */
  toolPrecision: number;
  pass: boolean;
}

export interface TaskSuccessScoreResult {
  turns: TaskSuccessTurnScore[];
  meanToolPrecision: number;
  overallPass: boolean;
}

export class TaskSuccessScorer {
  score(turns: TurnRunResult[], scenarioTurns: ScenarioTurn[]): TaskSuccessScoreResult {
    const turnScores: TaskSuccessTurnScore[] = turns.map((turn, i) => {
      const scenarioTurn = scenarioTurns[i];
      if (!scenarioTurn) return { expectedTools: [], dispatchedTools: [], toolPrecision: 1, pass: true };
      return this.scoreTurn(turn, scenarioTurn);
    });

    const total = turnScores.reduce((sum, t) => sum + t.toolPrecision, 0);
    const meanToolPrecision = turnScores.length > 0 ? total / turnScores.length : 1;
    const overallPass = turnScores.every((t) => t.pass);

    return { turns: turnScores, meanToolPrecision, overallPass };
  }

  private scoreTurn(turn: TurnRunResult, scenarioTurn: ScenarioTurn): TaskSuccessTurnScore {
    const expectedTools = scenarioTurn.expectations?.tools ?? [];
    const dispatchedTools = turn.toolsDispatched;

    let toolPrecision = 1;
    let pass = true;

    if (expectedTools.length > 0) {
      const dispatchedSet = new Set(dispatchedTools);
      const matched = expectedTools.filter((t) => dispatchedSet.has(t)).length;
      toolPrecision = matched / expectedTools.length;
      pass = toolPrecision >= 1.0;
    }

    return { expectedTools, dispatchedTools, toolPrecision, pass };
  }
}
