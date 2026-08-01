/**
 * ConversationOrchestrator — async iterable turn engine (WO-058, WO-059, WO-060).
 *
 * Produces a sequence of typed SinkEvents by:
 *   1. Yielding message_start immediately.
 *   2. Estimating input tokens; compacting history if the cap would be exceeded.
 *   3. Streaming model chunks from ModelClientPort (text buffered for grounding).
 *   4. Accumulating tool call inputs and dispatching via BudgetedToolDispatcher.
 *   5. Populating ProvenanceLedger from successful tool results.
 *   6. Yielding tool_start / tool_end around each dispatch.
 *   7. After each round: running ClaimExtractor → GroundingVerifier → ResponseAssembler
 *      and emitting only grounded text_delta + verified offer_card events.
 *   8. Repeating if the model signals tool_use stop reason (multi-turn loop).
 *   9. Yielding message_end with token totals, status, and groundingRefs.
 *
 * Text deltas are buffered until grounding verification completes — no
 * unsupported factual claim is ever emitted to the client.
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
import { ProvenanceLedger } from "../grounding/ProvenanceLedger.js";
import { ClaimExtractor } from "../grounding/ClaimExtractor.js";
import { GroundingVerifier } from "../grounding/GroundingVerifier.js";
import { ResponseAssembler } from "../grounding/ResponseAssembler.js";
import type { GroundingRef } from "../grounding/ResponseAssembler.js";
import type { PromptTemplate } from "../safety/PromptTemplate.js";
import { UntrustedContentWrapper } from "../safety/UntrustedContentWrapper.js";
import { InjectionScreener } from "../safety/InjectionScreener.js";
import { RefusalPolicy } from "../safety/RefusalPolicy.js";
import { OutputSanitiser } from "../safety/OutputSanitiser.js";
import { NOOP_SAFETY_METRICS } from "../safety/SafetyMetrics.js";
import type { SafetyMetrics } from "../safety/SafetyMetrics.js";

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

export interface OrchestratorSafetyConfig {
  /** Versioned prompt template (defaults to default template when omitted). */
  promptTemplate?: PromptTemplate;
  /** Overrides default UntrustedContentWrapper. */
  contentWrapper?: UntrustedContentWrapper;
  /** Overrides default InjectionScreener. */
  injectionScreener?: InjectionScreener;
  /** Overrides default RefusalPolicy. */
  refusalPolicy?: RefusalPolicy;
  /** Overrides default OutputSanitiser. */
  outputSanitiser?: OutputSanitiser;
  /** OTel safety metrics. Defaults to no-op. */
  metrics?: SafetyMetrics;
}

export interface OrchestratorConfig {
  /** Budget caps — enforced server-side, cannot be changed by clients. */
  budgetCaps?: Partial<BudgetCaps>;
  /** Injected clock for deterministic testing. */
  clock?: () => number;
  /** Grounding freshness window in ms (default: 15 minutes). */
  freshnessWindowMs?: number;
  /** Safety/injection-defence configuration. */
  safety?: OrchestratorSafetyConfig;
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
  private readonly freshnessWindowMs: number;
  private readonly promptTemplate: PromptTemplate | undefined;
  private readonly contentWrapper: UntrustedContentWrapper;
  private readonly injectionScreener: InjectionScreener;
  private readonly refusalPolicy: RefusalPolicy;
  private readonly outputSanitiser: OutputSanitiser;
  private readonly safetyMetrics: SafetyMetrics;

  constructor(
    private readonly modelClient: ModelClientPort,
    /** Raw ToolDispatcher — wrapped in BudgetedToolDispatcher per turn. */
    private readonly toolDispatcher: ToolDispatcher,
    private readonly toolRegistry: ToolRegistry,
    config: OrchestratorConfig = {},
  ) {
    this.caps = { ...DEFAULT_CAPS, ...config.budgetCaps };
    this.clock = config.clock ?? (() => Date.now());
    this.freshnessWindowMs = config.freshnessWindowMs ?? 15 * 60 * 1000;
    const safety = config.safety ?? {};
    this.promptTemplate = safety.promptTemplate;
    this.contentWrapper = safety.contentWrapper ?? new UntrustedContentWrapper();
    this.injectionScreener = safety.injectionScreener ?? new InjectionScreener();
    this.refusalPolicy = safety.refusalPolicy ?? new RefusalPolicy();
    this.outputSanitiser = safety.outputSanitiser ?? new OutputSanitiser();
    this.safetyMetrics = safety.metrics ?? NOOP_SAFETY_METRICS;
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
    yield { type: "message_start", version: "1", turnId, conversationId } as MessageStartEvent;

    // Per-turn instances — none shared across turns
    const guard = new BudgetGuard(this.caps, existingConversationTokens, this.clock);
    const budgetedDispatcher = new BudgetedToolDispatcher(this.toolDispatcher, guard);
    const ledger = new ProvenanceLedger();
    const claimExtractor = new ClaimExtractor();
    const verifier = new GroundingVerifier(this.freshnessWindowMs, this.clock);
    const assembler = new ResponseAssembler(this.freshnessWindowMs);

    // -----------------------------------------------------------------------
    // Safety: inbound user message screening (AC1, AC2, AC3, AC4)
    // -----------------------------------------------------------------------

    // Wrap user message in a labelled data block before prompt insertion.
    const wrappedUserMessage = this.contentWrapper.wrap("user", userMessage);

    // Screen raw user text for injection patterns.
    const recentContextTexts = history.map((m) => m.content);
    const detections = this.injectionScreener.screen(
      userMessage,
      recentContextTexts,
      turnId,
    );

    // Record detections in telemetry (AC9) — no user free text in labels.
    for (const d of detections) {
      this.safetyMetrics.recordDetection(d.patternClass);
    }

    // Evaluate whether to refuse.
    const refusalDecision = this.refusalPolicy.evaluate(detections);
    if (refusalDecision.refuse) {
      this.safetyMetrics.recordRefusal(refusalDecision.reason);
      yield { type: "text_delta", text: refusalDecision.message } as TextDeltaEvent;
      yield {
        type: "message_end",
        turnId,
        status: "refused",
        tokenUsage: guard.turnUsage,
      } as MessageEndEvent;
      return;
    }

    let status: "complete" | "incomplete" = "complete";
    let capNotice: string | undefined;
    /** All groundingRefs collected across rounds — emitted in message_end for persistence. */
    const allGroundingRefs: GroundingRef[] = [];

    const toolDefs = this.toolRegistry.list().map((t: AnthropicTool) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    // Insert the wrapped (escaped, data-block-labelled) user message into history.
    let messages: ModelMessage[] = [
      ...history,
      { role: "user", content: wrappedUserMessage.wrappedText },
    ];

    try {
      // Pre-turn input size check with optional compaction
      const preCheck = guard.beforeModelCall(estimateTotalInputTokens(messages, toolDefs));
      if (!preCheck.allowed) {
        messages = await this.tryCompact(messages);
        if (!messages || guard.beforeModelCall(estimateTotalInputTokens(messages, toolDefs)).allowed === false) {
          status = "incomplete";
          capNotice = CAP_NOTICE.INPUT_TOKENS;
          yield { type: "text_delta", text: capNotice } as TextDeltaEvent;
          yield { type: "message_end", turnId, status: "incomplete", tokenUsage: guard.turnUsage } as MessageEndEvent;
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

        if (signal.aborted) { status = "incomplete"; break loop; }

        const pendingToolCalls = new Map<string, ModelToolCall>();
        let roundStopReason: string | undefined;
        let assistantContent = "";

        // Per-round model call check
        const modelCheck = guard.beforeModelCall(estimateTotalInputTokens(messages, toolDefs));
        if (!modelCheck.allowed) {
          let compacted = false;
          try { messages = compactHistory(messages, this.caps.maxInputTokensPerCall); compacted = true; } catch { /* stop */ }
          if (!compacted || !guard.beforeModelCall(estimateTotalInputTokens(messages, toolDefs)).allowed) {
            status = "incomplete";
            capNotice = CAP_NOTICE[modelCheck.cap];
            break loop;
          }
        }

        const stream = this.modelClient.streamTurn({ messages, tools: toolDefs, signal });

        for await (const chunk of stream) {
          if (signal.aborted) { status = "incomplete"; break; }

          switch (chunk.type) {
            case "text_delta":
              // Buffer — do not emit yet; grounding verification runs after round
              assistantContent += chunk.textDelta ?? "";
              break;

            case "tool_call_start":
              if (chunk.toolCallId && chunk.toolName) {
                pendingToolCalls.set(chunk.toolCallId, {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  inputJson: "",
                });
                yield { type: "tool_start", toolCallId: chunk.toolCallId, tool: chunk.toolName } as ToolStartEvent;
              }
              break;

            case "tool_call_delta": {
              const tc = pendingToolCalls.get(chunk.toolCallId ?? "");
              if (tc) tc.inputJson += chunk.toolInputDelta ?? "";
              break;
            }

            case "tool_call_end":
              break;

            case "message_end":
              roundStopReason = chunk.stopReason;
              if (chunk.usage) {
                guard.afterModelCall({ inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens, isEstimated: false });
              } else {
                guard.afterModelCall({
                  inputTokens: estimateTotalInputTokens(messages, toolDefs),
                  outputTokens: Math.ceil(assistantContent.length / 3.5),
                  isEstimated: true,
                });
              }
              break;
          }
        }

        if (signal.aborted) { status = "incomplete"; break loop; }

        const durCheck = guard.assertWithinDuration();
        if (!durCheck.allowed) { status = "incomplete"; capNotice = CAP_NOTICE[durCheck.cap]; break loop; }

        // Dispatch accumulated tool calls for this round
        const toolResults: ModelMessage[] = [];
        if (pendingToolCalls.size > 0) {
          for (const tc of pendingToolCalls.values()) {
            if (signal.aborted) { status = "incomplete"; break; }

            let rawInput: unknown = {};
            try { rawInput = JSON.parse(tc.inputJson || "{}"); } catch { /* empty input */ }

            const result = await budgetedDispatcher.dispatch(tc.toolName, rawInput, ctx, signal);
            const typedResult = result as typeof result & { budgetDenied?: boolean };

            if (typedResult.budgetDenied) {
              status = "incomplete";
              capNotice = CAP_NOTICE.TOOL_CALLS;
              yield { type: "tool_end", toolCallId: tc.toolCallId, status: "failure", summary: "budget_exceeded" } as ToolEndEvent;
              break;
            }

            // Populate provenance ledger from successful tool results
            if (result.ok) {
              ledger.record(tc.toolName, result.data, this.clock());
            }

            yield {
              type: "tool_end",
              toolCallId: tc.toolCallId,
              status: result.ok ? "success" : "failure",
              summary: result.ok ? summarizeToolResult(result.data) : result.error.code,
            } as ToolEndEvent;

            // Wrap tool result free-text in a labelled data block (AC1, AC3).
            const toolContent = result.ok
              ? this.contentWrapper.wrapToolResult(tc.toolName, result.data)
              : `Error: ${result.error.message}`;
            toolResults.push({
              role: "tool",
              content: toolContent,
            });
          }
        }

        if (status === "incomplete") break loop;
        if (signal.aborted) { status = "incomplete"; break loop; }

        // --- Grounding assembly for this round ---
        // Runs AFTER tool dispatches so the ledger is fully populated
        if (assistantContent.length > 0 || ledger.size > 0) {
          try {
            const claims = claimExtractor.extract(assistantContent);
            const verdicts = verifier.verify(claims, ledger);
            const assembled = assembler.assemble(
              assistantContent,
              verdicts,
              ledger,
              this.clock(),
            );

            // Outbound sanitisation — strip executable markup, dangerous URIs,
            // invisible chars from assembled grounded text (AC5, AC6, AC7).
            const sanitised = this.outputSanitiser.sanitise(assembled.safeText);
            for (const action of sanitised.actions) {
              this.safetyMetrics.recordSanitiserAction(action.kind, action.count);
            }

            // Emit sanitised grounded text
            if (sanitised.safeText.length > 0) {
              yield { type: "text_delta", text: sanitised.safeText } as TextDeltaEvent;
            }

            // Emit grounded offer cards (sourced from ledger, never model text)
            for (const card of assembled.offerCards) {
              const offerEv: OfferCardEvent = {
                type: "offer_card",
                offerId: card.offerRef,
                provenance: card.supplier,
                tool: card.tool,
                currency: card.currency,
                price: card.price,
                retrievedAt: card.retrievedAt,
                stale: card.stale,
                displayTitle: card.displayTitle,
                displaySummary: card.displaySummary,
              };
              yield offerEv;
            }

            // Accumulate grounding refs for persistence
            allGroundingRefs.push(...assembled.groundingRefs);
          } catch {
            // Assembly bug → fail safe: still sanitise before emitting
            if (assistantContent.length > 0) {
              const fallbackSanitised = this.outputSanitiser.sanitise(assistantContent);
              for (const action of fallbackSanitised.actions) {
                this.safetyMetrics.recordSanitiserAction(action.kind, action.count);
              }
              yield { type: "text_delta", text: fallbackSanitised.safeText } as TextDeltaEvent;
            }
          }
        }

        if (assistantContent || pendingToolCalls.size > 0) {
          messages.push({ role: "assistant", content: assistantContent });
        }
        messages.push(...toolResults);

        if (roundStopReason !== "tool_use") break loop;
      }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        status = "incomplete";
      } else {
        throw err;
      }
    }

    if (capNotice && status === "incomplete") {
      yield { type: "text_delta", text: `\n\n${capNotice}` } as TextDeltaEvent;
    }

    const messageEnd: MessageEndEvent = {
      type: "message_end",
      turnId,
      status,
      tokenUsage: guard.turnUsage,
      groundingRefs: allGroundingRefs.length > 0 ? allGroundingRefs : undefined,
    };
    yield messageEnd;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async tryCompact(messages: ModelMessage[]): Promise<ModelMessage[]> {
    try {
      return compactHistory(messages, this.caps.maxInputTokensPerCall);
    } catch (e) {
      if (e instanceof CompactionError) return messages; // signal failure by returning original
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeToolResult(data: unknown): unknown {
  if (Array.isArray(data)) return `${data.length} result(s)`;
  if (typeof data === "object" && data !== null) {
    const keys = Object.keys(data as object);
    return keys.length > 0 ? `{ ${keys.slice(0, 3).join(", ")} }` : "{}";
  }
  return String(data);
}
