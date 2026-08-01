/**
 * BudgetGuard — per-turn cost accounting and cap enforcement (WO-059).
 *
 * Holds mutable counters for a single assistant turn.  Every model call and
 * tool dispatch is gated through this guard; cap breaches are returned as
 * typed domain outcomes (not exceptions) so the orchestrator can finish the
 * turn gracefully and preserve partial output.
 *
 * Duration cap uses the injected clock() so tests can control time.
 *
 * Thread safety: one BudgetGuard per turn, never shared across turns.
 */

// ---------------------------------------------------------------------------
// Cap configuration
// ---------------------------------------------------------------------------

export interface BudgetCaps {
  /** Maximum tool calls across all rounds in a single turn. Default: 10. */
  maxToolCallsPerTurn: number;
  /** Maximum tool-use loop rounds per turn. Default: 5. */
  maxIterationsPerTurn: number;
  /** Maximum estimated input tokens per individual model call. Default: 50 000. */
  maxInputTokensPerCall: number;
  /** Maximum cumulative output tokens across all model calls in a turn. Default: 8 000. */
  maxOutputTokensPerTurn: number;
  /** Maximum cumulative tokens (input + output) across the entire conversation. Default: 200 000. */
  maxConversationTokens: number;
  /** Maximum wall-clock milliseconds from turn start to guard check. Default: 60 000. */
  maxDurationMs: number;
}

// ---------------------------------------------------------------------------
// Domain outcome types
// ---------------------------------------------------------------------------

export type CapKind =
  | "TOOL_CALLS"
  | "ITERATIONS"
  | "INPUT_TOKENS"
  | "OUTPUT_TOKENS"
  | "CONVERSATION_TOKENS"
  | "DURATION";

export type GuardOutcome =
  | { allowed: true }
  | { allowed: false; cap: CapKind };

export const GUARD_ALLOWED: GuardOutcome = { allowed: true };

// ---------------------------------------------------------------------------
// Token usage record
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  isEstimated?: boolean;
}

// ---------------------------------------------------------------------------
// Metrics port — duck-typed so domain layer has no OTel dep
// ---------------------------------------------------------------------------

export interface MetricsPort {
  increment(name: string, value?: number, labels?: Record<string, string>): void;
  record(name: string, value: number, labels?: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// BudgetGuard
// ---------------------------------------------------------------------------

export class BudgetGuard {
  private toolCallCount = 0;
  private iterationCount = 0;
  private inputTokensThisTurn = 0;
  private outputTokensThisTurn = 0;
  /** Running total for the entire conversation (existing + new this turn). */
  private conversationTokens: number;
  private readonly startMs: number;

  constructor(
    readonly caps: BudgetCaps,
    existingConversationTokens: number,
    private readonly clock: () => number = () => Date.now(),
    private readonly metrics?: MetricsPort,
  ) {
    this.startMs = this.clock();
    this.conversationTokens = existingConversationTokens;
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  /**
   * Call at the top of each tool-use loop iteration.
   * Checks: iteration count, output token cap, conversation token cap, duration.
   */
  beforeIteration(): GuardOutcome {
    const dur = this.assertWithinDuration();
    if (!dur.allowed) return dur;

    if (this.outputTokensThisTurn >= this.caps.maxOutputTokensPerTurn) {
      return this.deny("OUTPUT_TOKENS");
    }
    if (this.conversationTokens >= this.caps.maxConversationTokens) {
      return this.deny("CONVERSATION_TOKENS");
    }
    if (this.iterationCount >= this.caps.maxIterationsPerTurn) {
      return this.deny("ITERATIONS");
    }
    this.iterationCount++;
    return GUARD_ALLOWED;
  }

  /**
   * Call before sending a model request.
   * Returns denied when the estimated input tokens exceed the per-call cap.
   */
  beforeModelCall(estimatedInputTokens: number): GuardOutcome {
    if (estimatedInputTokens > this.caps.maxInputTokensPerCall) {
      return this.deny("INPUT_TOKENS");
    }
    return this.assertWithinDuration();
  }

  /**
   * Call after receiving a model response.
   * Records actual or estimated token usage.
   * Returns updated turn totals (never throws).
   */
  afterModelCall(usage: TokenUsage): { inputTokensThisTurn: number; outputTokensThisTurn: number } {
    this.inputTokensThisTurn += usage.inputTokens;
    this.outputTokensThisTurn += usage.outputTokens;
    this.conversationTokens += usage.inputTokens + usage.outputTokens;

    this.metrics?.increment("budget.tokens_in", usage.inputTokens);
    this.metrics?.increment("budget.tokens_out", usage.outputTokens);
    if (usage.isEstimated) {
      this.metrics?.increment("budget.usage_estimated", 1);
    }

    return {
      inputTokensThisTurn: this.inputTokensThisTurn,
      outputTokensThisTurn: this.outputTokensThisTurn,
    };
  }

  /**
   * Call before dispatching a tool.
   * Checks: tool call count, output token cap, conversation token cap.
   */
  beforeToolCall(): GuardOutcome {
    if (this.toolCallCount >= this.caps.maxToolCallsPerTurn) {
      return this.deny("TOOL_CALLS");
    }
    if (this.outputTokensThisTurn >= this.caps.maxOutputTokensPerTurn) {
      return this.deny("OUTPUT_TOKENS");
    }
    if (this.conversationTokens >= this.caps.maxConversationTokens) {
      return this.deny("CONVERSATION_TOKENS");
    }
    return GUARD_ALLOWED;
  }

  /** Call after a tool dispatch completes (regardless of outcome). */
  afterToolCall(): void {
    this.toolCallCount++;
    this.metrics?.increment("budget.tool_calls", 1);
  }

  /**
   * Monotonic duration check.
   * Can be called at any point to detect a stalled turn.
   */
  assertWithinDuration(): GuardOutcome {
    const elapsed = this.clock() - this.startMs;
    if (elapsed >= this.caps.maxDurationMs) {
      return this.deny("DURATION");
    }
    return GUARD_ALLOWED;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get turnUsage(): TokenUsage {
    return {
      inputTokens: this.inputTokensThisTurn,
      outputTokens: this.outputTokensThisTurn,
    };
  }

  get toolCallsUsed(): number { return this.toolCallCount; }
  get iterationsUsed(): number { return this.iterationCount; }
  get elapsedMs(): number { return this.clock() - this.startMs; }

  // ---------------------------------------------------------------------------
  // Metrics helpers
  // ---------------------------------------------------------------------------

  /** Record a cost estimate in micro-dollars (label kept low-cardinality). */
  recordEstimatedCost(microDollars: number): void {
    this.metrics?.record("budget.estimated_cost_usd", microDollars / 1_000_000);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private deny(cap: CapKind): GuardOutcome {
    this.metrics?.increment("budget.cap_hits", 1, { cap });
    return { allowed: false, cap };
  }
}

// ---------------------------------------------------------------------------
// User-facing notice messages for each cap kind
// ---------------------------------------------------------------------------

export const CAP_NOTICE: Record<CapKind, string> = {
  TOOL_CALLS:
    "I've reached the search limit for this turn. Here's what I found so far — let me know if you'd like me to continue in a new message.",
  ITERATIONS:
    "I've completed the maximum number of search rounds for this turn. Here are the results I've gathered so far.",
  INPUT_TOKENS:
    "Your conversation history is too long for me to process in a single turn. Please start a new conversation or ask a more focused question.",
  OUTPUT_TOKENS:
    "I've reached the response length limit for this turn. Here's what I have so far.",
  CONVERSATION_TOKENS:
    "This conversation has reached its total token limit. Please start a new conversation to continue planning.",
  DURATION:
    "This turn took longer than expected. Here are the partial results I managed to gather.",
};
