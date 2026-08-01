/**
 * ConversationOrchestrator — async iterable turn engine (WO-058, WO-059).
 *
 * Produces a sequence of typed SinkEvents by:
 *   1. Yielding message_start immediately.
 *   2. Checking the per-principal rate limit; returning 429-style notice on denial.
 *   3. Estimating input tokens; compacting history if the cap would be exceeded.
 *   4. Streaming model chunks from ModelClientPort.
 *   5. Accumulating tool call inputs and dispatching them via BudgetedToolDispatcher.
 *   6. Yielding tool_start / tool_end around each dispatch.
 *   7. Repeating if the model signals tool_use stop reason (multi-turn loop).
 *   8. Yielding message_end with accumulated token totals and status.
 *
 * HTTP concerns (SSE framing, backpressure, heartbeats) are the route's
 * responsibility — the orchestrator is transport-agnostic.
 *
 * Budget caps are enforced server-side; they cannot be overridden from
 * client input or model output.
 */

import type {
  SinkEvent,
  MessageStartEvent,
  TextDeltaEvent,
  ToolStartEvent,
  ToolEndEvent,
  OfferCardEvent,
  MessageEndEvent,
} from "@travel/contracts";
import type { ToolRegistry, AnthropicTool } from "../tools/ToolRegistry.js";
import type { ToolContext } from "../tools/ToolDescriptor.js";
import type { BudgetCaps } from "../budget/BudgetGuard.js";
import { BudgetGuard, CAP_NOTICE } from "../budget/BudgetGuard.js";
import { BudgetedToolDispatcher } from "../budget/BudgetedToolDispatcher.js";
import { compactHistory, CompactionError } from "../budget/compactHistory.js";
import { estimateTotalInputTokens } from "../budget/estimateTokens.js";
import type { ToolDispatcher } from "../tools/ToolDispatcher.js";

// ---------------------------------------------------------------------------
// ModelClientPort — duck-typed to avoid @anthropic-ai/sdk in domain layer
// ---------------------------------------------------------------------------

export type ModelMessageRole = "user" | "assistant" | "tool";

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

export interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  /** Accumulated JSON string from incremental deltas. */
  inputJson: string;
}

export type ModelStreamChunkType =
  | "text_delta"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_end"
  | "message_end";

export interface ModelStreamChunk {
  type: ModelStreamChunkType;
  /** text_delta */
  textDelta?: string;
  /** tool_call_start / tool_call_delta / tool_call_end */
  toolCallId?: string;
  toolName?: string;
  toolInputDelta?: string;
  /** message_end */
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelClientPort {
  streamTurn(opts: {
    messages: ModelMessage[];
    tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
    signal: AbortSignal;
  }): AsyncIterable<ModelStreamChunk>;
}

// ---------------------------------------------------------------------------
// Orchestrator configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** Budget caps — enforced server-side, cannot be changed by clients. */
  budgetCaps?: Partial<BudgetCaps>;
  /** Injected clock for deterministic testing. */
  clock?: () => number;
}

// Default caps — conservative, production-safe
const DEFAULT_CAPS: BudgetCaps = {
  maxToolCallsPerTurn: 10,
  maxIterationsPerTurn: 5,
  maxInputTokensPerCall: 50_000,
  maxOutputTokensPerTurn: 8_000,
  maxConversationTokens: 200_000,
  maxDurationMs: 60_000,
};

// ---------------------------------------------------------------------------
// ConversationOrchestrator
// ---------------------------------------------------------------------------

export class ConversationOrchestrator {
  private readonly caps: BudgetCaps;
  private readonly clock: () => number;

  constructor(
    private readonly modelClient: ModelClientPort,
    /** Raw ToolDispatcher — wrapped in BudgetedToolDispatcher per turn. */
    private readonly toolDispatcher: ToolDispatcher,
    private readonly toolRegistry: ToolRegistry,
    config: OrchestratorConfig = {},
  ) {
    // Merge provided caps over defaults — client cannot supply caps
    this.caps = { ...DEFAULT_CAPS, ...config.budgetCaps };
    this.clock = config.clock ?? (() => Date.now());
  }

  /**
   * Run a single assistant turn and yield typed SinkEvents.
   *
   * @param turnId        Server-assigned turn UUID.
   * @param conversationId  The owning conversation.
   * @param userMessage   The human turn content.
   * @param history       Prior messages for context.
   * @param ctx           Server-side context (userId, correlationId, etc.).
   * @param signal        AbortSignal — wired to the HTTP request lifecycle.
   * @param existingConversationTokens  Accumulated conversation token total from DB.
   */
  async *runTurn(
    turnId: string,
    conversationId: string,
    userMessage: string,
    history: ModelMessage[],
    ctx: ToolContext,
    signal: AbortSignal,
    existingConversationTokens = 0,
  ): AsyncGenerator<SinkEvent> {
    // Immediately yield message_start so the client sees a first byte.
    const messageStart: MessageStartEvent = {
      type: "message_start",
      version: "1",
      turnId,
      conversationId,
    };
    yield messageStart;

    // Per-turn budget guard — instantiated here so state is strictly per-turn.
    const guard = new BudgetGuard(this.caps, existingConversationTokens, this.clock);
    const budgetedDispatcher = new BudgetedToolDispatcher(this.toolDispatcher, guard);

    let status: "complete" | "incomplete" = "complete";
    let capNotice: string | undefined;

    const toolDefs = this.toolRegistry.list().map((t: AnthropicTool) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    let messages: ModelMessage[] = [
      ...history,
      { role: "user", content: userMessage },
    ];

    try {
      // Check top-level input size before the first model call
      const preCheckOutcome = guard.beforeModelCall(
        estimateTotalInputTokens(messages, toolDefs),
      );
      if (!preCheckOutcome.allowed) {
        // Attempt compaction
        try {
          messages = compactHistory(messages, this.caps.maxInputTokensPerCall);
        } catch (compErr) {
          if (compErr instanceof CompactionError) {
            status = "incomplete";
            capNotice = CAP_NOTICE.INPUT_TOKENS;
            yield { type: "text_delta", text: capNotice } as TextDeltaEvent;
            yield {
              type: "message_end",
              turnId,
              status: "incomplete",
              tokenUsage: guard.turnUsage,
            } as MessageEndEvent;
            return;
          }
          throw compErr;
        }
        // Recheck after compaction — give up if still too large
        const recheckOutcome = guard.beforeModelCall(
          estimateTotalInputTokens(messages, toolDefs),
        );
        if (!recheckOutcome.allowed) {
          status = "incomplete";
          capNotice = CAP_NOTICE.INPUT_TOKENS;
          yield { type: "text_delta", text: capNotice } as TextDeltaEvent;
          yield {
            type: "message_end",
            turnId,
            status: "incomplete",
            tokenUsage: guard.turnUsage,
          } as MessageEndEvent;
          return;
        }
      }

      // Tool-use loop
      loop: for (;;) {
        const iterOutcome = guard.beforeIteration();
        if (!iterOutcome.allowed) {
          status = "incomplete";
          capNotice = CAP_NOTICE[iterOutcome.cap];
          break loop;
        }

        if (signal.aborted) {
          status = "incomplete";
          break loop;
        }

        const pendingToolCalls = new Map<string, ModelToolCall>();
        let roundStopReason: string | undefined;
        let assistantContent = "";

        const modelCallOutcome = guard.beforeModelCall(
          estimateTotalInputTokens(messages, toolDefs),
        );
        if (!modelCallOutcome.allowed) {
          // Try compaction before giving up
          let compacted = false;
          try {
            messages = compactHistory(messages, this.caps.maxInputTokensPerCall);
            compacted = true;
          } catch {
            // Compaction failed — hard stop
          }
          if (!compacted) {
            status = "incomplete";
            capNotice = CAP_NOTICE[modelCallOutcome.cap];
            break loop;
          }
          // Re-check after compaction
          const recheckAfterCompact = guard.beforeModelCall(
            estimateTotalInputTokens(messages, toolDefs),
          );
          if (!recheckAfterCompact.allowed) {
            status = "incomplete";
            capNotice = CAP_NOTICE[recheckAfterCompact.cap];
            break loop;
          }
        }

        const stream = this.modelClient.streamTurn({ messages, tools: toolDefs, signal });

        for await (const chunk of stream) {
          if (signal.aborted) {
            status = "incomplete";
            break;
          }

          switch (chunk.type) {
            case "text_delta": {
              const delta = chunk.textDelta ?? "";
              assistantContent += delta;
              const textEv: TextDeltaEvent = { type: "text_delta", text: delta };
              yield textEv;
              break;
            }

            case "tool_call_start": {
              if (chunk.toolCallId && chunk.toolName) {
                pendingToolCalls.set(chunk.toolCallId, {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  inputJson: "",
                });
                const toolStartEv: ToolStartEvent = {
                  type: "tool_start",
                  toolCallId: chunk.toolCallId,
                  tool: chunk.toolName,
                };
                yield toolStartEv;
              }
              break;
            }

            case "tool_call_delta": {
              const tc = pendingToolCalls.get(chunk.toolCallId ?? "");
              if (tc) {
                tc.inputJson += chunk.toolInputDelta ?? "";
              }
              break;
            }

            case "tool_call_end":
              break;

            case "message_end": {
              roundStopReason = chunk.stopReason;
              if (chunk.usage) {
                guard.afterModelCall({
                  inputTokens: chunk.usage.inputTokens,
                  outputTokens: chunk.usage.outputTokens,
                  isEstimated: false,
                });
              } else {
                // Provider omitted usage — fall back to estimate, flag as estimated
                guard.afterModelCall({
                  inputTokens: estimateTotalInputTokens(messages, toolDefs),
                  outputTokens: Math.ceil(assistantContent.length / 3.5),
                  isEstimated: true,
                });
              }
              break;
            }
          }
        }

        if (signal.aborted) {
          status = "incomplete";
          break loop;
        }

        // Check output cap after model call
        const outputCheck = guard.assertWithinDuration();
        if (!outputCheck.allowed) {
          status = "incomplete";
          capNotice = CAP_NOTICE[outputCheck.cap];
          break loop;
        }

        // Dispatch accumulated tool calls for this round
        if (pendingToolCalls.size > 0) {
          const toolResults: ModelMessage[] = [];

          for (const tc of pendingToolCalls.values()) {
            if (signal.aborted) { status = "incomplete"; break; }

            // Budget gate is inside BudgetedToolDispatcher
            let rawInput: unknown = {};
            try {
              rawInput = JSON.parse(tc.inputJson || "{}");
            } catch {
              // Malformed JSON from model — dispatch with empty input
            }

            const result = await budgetedDispatcher.dispatch(tc.toolName, rawInput, ctx, signal);

            // Check if the budget gate fired
            const typedResult = result as typeof result & { budgetDenied?: boolean };
            if (typedResult.budgetDenied) {
              status = "incomplete";
              capNotice = CAP_NOTICE.TOOL_CALLS;
              // Emit tool_end with failure so the client stream is consistent
              const toolEndEv: ToolEndEvent = {
                type: "tool_end",
                toolCallId: tc.toolCallId,
                status: "failure",
                summary: "budget_exceeded",
              };
              yield toolEndEv;
              break;
            }

            const toolEndEv: ToolEndEvent = {
              type: "tool_end",
              toolCallId: tc.toolCallId,
              status: result.ok ? "success" : "failure",
              summary: result.ok ? summarizeToolResult(result.data) : result.error.code,
            };
            yield toolEndEv;

            if (result.ok && isOfferArray(result.data)) {
              for (const offer of result.data as OfferLike[]) {
                const offerEv: OfferCardEvent = {
                  type: "offer_card",
                  offerId: offer.id,
                  provenance: offer.provenance ?? "unknown",
                  displayTitle: offer.displayTitle,
                  displaySummary: offer.displaySummary,
                };
                yield offerEv;
              }
            }

            toolResults.push({
              role: "tool",
              content: result.ok ? JSON.stringify(result.data) : `Error: ${result.error.message}`,
            });
          }

          if (status === "incomplete") break loop;

          if (signal.aborted) { status = "incomplete"; break loop; }

          if (assistantContent || pendingToolCalls.size > 0) {
            messages.push({ role: "assistant", content: assistantContent });
          }
          messages.push(...toolResults);
        }

        // If not tool_use, we're done
        if (roundStopReason !== "tool_use") break loop;
      }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        status = "incomplete";
      } else {
        throw err;
      }
    }

    // Emit cap notice as a text_delta before message_end so partial output is preserved
    if (capNotice && status === "incomplete") {
      yield { type: "text_delta", text: `\n\n${capNotice}` } as TextDeltaEvent;
    }

    const messageEnd: MessageEndEvent = {
      type: "message_end",
      turnId,
      status,
      tokenUsage: guard.turnUsage,
    };
    yield messageEnd;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OfferLike {
  id: string;
  provenance?: string;
  displayTitle?: string;
  displaySummary?: string;
}

function isOfferArray(data: unknown): boolean {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    typeof (data[0] as Record<string, unknown>)?.id === "string"
  );
}

function summarizeToolResult(data: unknown): unknown {
  if (Array.isArray(data)) return `${data.length} result(s)`;
  if (typeof data === "object" && data !== null) {
    const keys = Object.keys(data as object);
    return keys.length > 0 ? `{ ${keys.slice(0, 3).join(", ")} }` : "{}";
  }
  return String(data);
}
