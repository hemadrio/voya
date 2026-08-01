/**
 * ConversationOrchestrator — async iterable turn engine (WO-058).
 *
 * Produces a sequence of typed SinkEvents by:
 *   1. Yielding message_start immediately.
 *   2. Streaming model chunks from ModelClientPort.
 *   3. Accumulating tool call inputs and dispatching them via ToolDispatcher.
 *   4. Yielding tool_start / tool_end around each dispatch.
 *   5. Repeating if the model signals tool_use stop reason (multi-turn loop).
 *   6. Yielding message_end with accumulated token totals.
 *
 * HTTP concerns (SSE framing, backpressure, heartbeats) are the route's
 * responsibility — the orchestrator is transport-agnostic.
 *
 * Cancellation is propagated via the AbortSignal threaded through every
 * async operation; on abort the generator returns cleanly without throwing.
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
import type { ToolDispatcher } from "../tools/ToolDispatcher.js";
import type { ToolRegistry, AnthropicTool } from "../tools/ToolRegistry.js";
import type { ToolContext } from "../tools/ToolDescriptor.js";

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
  /** Maximum tool-use loop iterations per turn. Default: 5. */
  maxToolRounds?: number;
}

// ---------------------------------------------------------------------------
// ConversationOrchestrator
// ---------------------------------------------------------------------------

export class ConversationOrchestrator {
  private readonly maxToolRounds: number;

  constructor(
    private readonly modelClient: ModelClientPort,
    private readonly toolDispatcher: ToolDispatcher,
    private readonly toolRegistry: ToolRegistry,
    config: OrchestratorConfig = {},
  ) {
    this.maxToolRounds = config.maxToolRounds ?? 5;
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
   */
  async *runTurn(
    turnId: string,
    conversationId: string,
    userMessage: string,
    history: ModelMessage[],
    ctx: ToolContext,
    signal: AbortSignal,
  ): AsyncGenerator<SinkEvent> {
    // Immediately yield message_start so the client sees a first byte.
    const messageStart: MessageStartEvent = {
      type: "message_start",
      version: "1",
      turnId,
      conversationId,
    };
    yield messageStart;

    let inputTokens = 0;
    let outputTokens = 0;
    let status: "complete" | "incomplete" = "complete";

    const messages: ModelMessage[] = [
      ...history,
      { role: "user", content: userMessage },
    ];

    // Tool definitions from registry
    const toolDefs = this.toolRegistry.list().map((t: AnthropicTool) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    try {
      for (let round = 0; round < this.maxToolRounds; round++) {
        if (signal.aborted) {
          status = "incomplete";
          break;
        }

        const pendingToolCalls = new Map<string, ModelToolCall>();
        let roundStopReason: string | undefined;
        let assistantContent = "";

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
              // Input accumulation is complete — dispatch happens after message_end
              break;

            case "message_end": {
              roundStopReason = chunk.stopReason;
              if (chunk.usage) {
                inputTokens += chunk.usage.inputTokens;
                outputTokens += chunk.usage.outputTokens;
              }
              break;
            }
          }
        }

        if (signal.aborted) {
          status = "incomplete";
          break;
        }

        // Dispatch accumulated tool calls for this round
        if (pendingToolCalls.size > 0) {
          const toolResults: ModelMessage[] = [];

          for (const tc of pendingToolCalls.values()) {
            if (signal.aborted) { status = "incomplete"; break; }

            let rawInput: unknown = {};
            try {
              rawInput = JSON.parse(tc.inputJson || "{}");
            } catch {
              // Malformed JSON from model — dispatch with empty input
            }

            const result = await this.toolDispatcher.dispatch(tc.toolName, rawInput, ctx, signal);

            const toolEndEv: ToolEndEvent = {
              type: "tool_end",
              toolCallId: tc.toolCallId,
              status: result.ok ? "success" : "failure",
              summary: result.ok ? summarizeToolResult(result.data) : result.error.code,
            };
            yield toolEndEv;

            // If tool returned offer cards, yield them
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

          if (signal.aborted) { status = "incomplete"; break; }

          // Update messages for next round
          if (assistantContent || pendingToolCalls.size > 0) {
            messages.push({ role: "assistant", content: assistantContent });
          }
          messages.push(...toolResults);
        }

        // If not tool_use, we're done
        if (roundStopReason !== "tool_use") break;
      }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        status = "incomplete";
      } else {
        throw err;
      }
    }

    const messageEnd: MessageEndEvent = {
      type: "message_end",
      turnId,
      status,
      tokenUsage: { inputTokens, outputTokens },
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
