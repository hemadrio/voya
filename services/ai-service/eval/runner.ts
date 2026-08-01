/**
 * Eval runner — executes scenarios through the real ConversationOrchestrator
 * with injected stub transports (WO-063, AC3).
 *
 * Deterministic by design:
 *   - Clock advances by a fixed step per call (no Date.now() usage).
 *   - Turn IDs and conversation IDs are derived from scenario/turn index.
 *   - Stub model client replays scripted transcripts, no network access.
 *   - Stub tool dispatcher returns pre-recorded responses, no HTTP calls.
 *
 * Runs fully offline — no LLM provider or supplier network calls.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { ConversationOrchestrator } from "../src/domain/orchestrator/ConversationOrchestrator.js";
import type { ModelClientPort, ModelStreamChunk, OrchestratorConfig } from "../src/domain/orchestrator/ConversationOrchestrator.js";
import type { ToolDispatcher, DispatchResult } from "../src/domain/tools/ToolDispatcher.js";
import type { ToolContext } from "../src/domain/tools/ToolDescriptor.js";
import { createDefaultRegistry } from "../src/tools.js";
import type { SinkEvent } from "@travel/contracts";
import { validateScenario } from "./schema.js";
import type { Scenario, ScenarioTurn, StubbedToolResponse } from "./schema.js";

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

/** Returns a clock function that advances by STEP_MS on every call. */
function makeDeterministicClock(startMs = 0, stepMs = 10): { clock: () => number; value: () => number } {
  let current = startMs;
  return {
    clock: () => { current += stepMs; return current; },
    value: () => current,
  };
}

// ---------------------------------------------------------------------------
// Stub ModelClientPort — replays scripted rounds
// ---------------------------------------------------------------------------

class StubModelClient implements ModelClientPort {
  private roundIndex = 0;

  constructor(private readonly rounds: ModelStreamChunk[][]) {}

  reset(): void { this.roundIndex = 0; }

  streamTurn(_opts: unknown): AsyncIterable<ModelStreamChunk> {
    const round = this.rounds[this.roundIndex] ?? [];
    this.roundIndex++;
    const chunks = round;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelStreamChunk> {
        let i = 0;
        return {
          next(): Promise<IteratorResult<ModelStreamChunk>> {
            if (i < chunks.length) {
              return Promise.resolve({ value: chunks[i++], done: false });
            }
            return Promise.resolve({ value: undefined as unknown as ModelStreamChunk, done: true });
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Stub ToolDispatcher — returns pre-recorded responses
// ---------------------------------------------------------------------------

class StubToolDispatcher implements Pick<ToolDispatcher, "dispatch"> {
  /** Per-tool call counter for keying by toolName:callIndex. */
  private callCounts = new Map<string, number>();

  constructor(private readonly responses: Record<string, StubbedToolResponse>) {}

  reset(): void { this.callCounts.clear(); }

  async dispatch(
    name: string,
    _rawInput: unknown,
    ctx: ToolContext,
    _signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const count = this.callCounts.get(name) ?? 0;
    this.callCounts.set(name, count + 1);
    const key = `${name}:${count}`;
    const recorded = this.responses[key];

    if (recorded === undefined) {
      // No stub for this call — return a safe empty result
      return { ok: true, tool: name, data: [] };
    }

    if (!recorded.ok) {
      return {
        ok: false,
        error: {
          code: (recorded.error?.code ?? "TOOL_UPSTREAM_ERROR") as import("../src/domain/tools/ToolDescriptor.js").ToolDispatchErrorCode,
          message: recorded.error?.message ?? "Stubbed failure",
          reference: ctx.correlationId,
        },
      };
    }

    return { ok: true, tool: name, data: recorded.data };
  }
}

// ---------------------------------------------------------------------------
// Turn run result
// ---------------------------------------------------------------------------

export interface TurnRunResult {
  turnIndex: number;
  events: SinkEvent[];
  firstEventMs: number;
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  toolsDispatched: string[];
  wasRefused: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Scenario run result
// ---------------------------------------------------------------------------

export interface ScenarioRunResult {
  scenarioId: string;
  description: string;
  turns: TurnRunResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Run a single scenario turn
// ---------------------------------------------------------------------------

async function runTurn(
  orchestrator: ConversationOrchestrator,
  turn: ScenarioTurn,
  turnIndex: number,
  scenarioId: string,
  clockValue: () => number,
): Promise<TurnRunResult> {
  const turnId = `eval-${scenarioId}-t${turnIndex}`;
  const conversationId = `eval-${scenarioId}`;
  const ctx: ToolContext = {
    conversationId,
    correlationId: `eval-correlation-${scenarioId}-t${turnIndex}`,
    userId: "eval-user-001",
  };
  const signal = new AbortController().signal;

  const events: SinkEvent[] = [];
  let firstEventMs: number | null = null;
  const startMs = clockValue();

  try {
    const generator = orchestrator.runTurn(
      turnId,
      conversationId,
      turn.userContent,
      [],
      ctx,
      signal,
      0,
    );

    for await (const event of generator) {
      if (firstEventMs === null) firstEventMs = clockValue() - startMs;
      events.push(event);
    }
  } catch (err) {
    return {
      turnIndex,
      events,
      firstEventMs: firstEventMs ?? clockValue() - startMs,
      totalMs: clockValue() - startMs,
      tokensIn: 0,
      tokensOut: 0,
      toolsDispatched: [],
      wasRefused: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const totalMs = clockValue() - startMs;

  // Extract token usage from message_end
  let tokensIn = 0;
  let tokensOut = 0;
  let wasRefused = false;
  const toolsDispatched: string[] = [];

  for (const ev of events) {
    if (ev.type === "message_end") {
      tokensIn = ev.tokenUsage?.inputTokens ?? 0;
      tokensOut = ev.tokenUsage?.outputTokens ?? 0;
      if (ev.status === "refused") wasRefused = true;
    }
    if (ev.type === "tool_start") {
      toolsDispatched.push(ev.tool);
    }
  }

  return {
    turnIndex,
    events,
    firstEventMs: firstEventMs ?? 0,
    totalMs,
    tokensIn,
    tokensOut,
    toolsDispatched,
    wasRefused,
  };
}

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

export async function runScenario(scenario: Scenario): Promise<ScenarioRunResult> {
  const results: TurnRunResult[] = [];

  for (let ti = 0; ti < scenario.turns.length; ti++) {
    const turn = scenario.turns[ti];
    const clockCtx = makeDeterministicClock(ti * 10_000, 10);

    const stubModel = new StubModelClient(turn.scriptedModelTranscript);
    const stubDispatcher = new StubToolDispatcher(turn.stubbedToolResponses ?? {});

    const registry = createDefaultRegistry("http://eval.internal");

    const orchConfig: OrchestratorConfig = {
      clock: clockCtx.clock,
      freshnessWindowMs: turn.freshnessWindowMs ?? 15 * 60 * 1000,
      budgetCaps: { maxDurationMs: 999_999_999 },
    };

    const orchestrator = new ConversationOrchestrator(
      stubModel,
      // StubToolDispatcher satisfies the ToolDispatcher shape (structural typing)
      stubDispatcher as unknown as ToolDispatcher,
      registry,
      orchConfig,
    );

    const turnResult = await runTurn(
      orchestrator,
      turn,
      ti,
      scenario.id,
      clockCtx.value,
    );
    results.push(turnResult);
  }

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    turns: results,
  };
}

// ---------------------------------------------------------------------------
// Load and run all scenarios from a directory
// ---------------------------------------------------------------------------

export async function runAllScenarios(scenariosDir: string): Promise<ScenarioRunResult[]> {
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const results: ScenarioRunResult[] = [];

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(scenariosDir, file), "utf-8")) as unknown;
    try {
      const scenario = validateScenario(raw, file);
      const result = await runScenario(scenario);
      results.push(result);
    } catch (err) {
      results.push({
        scenarioId: file.replace(".json", ""),
        description: "(failed to load)",
        turns: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
