/**
 * Budget-related model stream fixtures (WO-059).
 *
 * Used in integration tests that exercise cap enforcement:
 *   - runawayLoopStream:   Always returns tool_use; drives iteration cap.
 *   - oversizedHistoryStream: Returns text_delta with many tokens; drives input-token cap.
 *   - largeOutputStream:  Streams very long text; drives output-token cap.
 *
 * Each fixture implements the ModelClientPort.streamTurn interface.
 */

import type {
  ModelClientPort,
  ModelStreamChunk,
} from "../../src/domain/orchestrator/ConversationOrchestrator.js";

// ---------------------------------------------------------------------------
// runawayLoopStream — always returns tool_use stop reason
// ---------------------------------------------------------------------------

export const runawayLoopStream: ModelClientPort = {
  streamTurn: async function* ({ signal }): AsyncIterable<ModelStreamChunk> {
    if (signal.aborted) return;
    // Emit a short text delta then a tool call in every round
    yield { type: "text_delta", textDelta: "Searching..." };
    yield {
      type: "tool_call_start",
      toolCallId: `tc-runaway-${Math.floor(Math.random() * 10_000)}`,
      toolName: "search_flights",
    };
    yield {
      type: "tool_call_end",
      toolCallId: `tc-runaway-${Math.floor(Math.random() * 10_000)}`,
    };
    yield {
      type: "message_end",
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 5 },
    };
  },
};

// ---------------------------------------------------------------------------
// oversizedHistoryStream — expects to be called after compaction
// Returns end_turn immediately so we can verify compaction happened
// ---------------------------------------------------------------------------

export const oversizedHistoryStream: ModelClientPort = {
  streamTurn: async function* ({ messages, signal }): AsyncIterable<ModelStreamChunk> {
    if (signal.aborted) return;
    // Emits a text_delta that mentions how many messages it received
    yield { type: "text_delta", textDelta: `Received ${messages.length} messages` };
    yield {
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 30, outputTokens: 10 },
    };
  },
};

// ---------------------------------------------------------------------------
// largeOutputStream — streams a very long text to trigger output-token cap
// ---------------------------------------------------------------------------

/** Token limit at which the caller should stop.  Tests set this per-case. */
const LARGE_OUTPUT_CHUNK_COUNT = 200; // ~200 * 40 chars = 8000 chars = ~2285 tokens

export const largeOutputStream: ModelClientPort = {
  streamTurn: async function* ({ signal }): AsyncIterable<ModelStreamChunk> {
    if (signal.aborted) return;
    const chunk = "A".repeat(40); // 40 chars per delta
    for (let i = 0; i < LARGE_OUTPUT_CHUNK_COUNT; i++) {
      if (signal.aborted) return;
      yield { type: "text_delta", textDelta: chunk };
    }
    yield {
      type: "message_end",
      stopReason: "end_turn",
      // Emit large token counts to trip output cap
      usage: { inputTokens: 100, outputTokens: 10_000 },
    };
  },
};

// ---------------------------------------------------------------------------
// runawayWithToolIds — like runawayLoopStream but uses stable IDs for assertions
// ---------------------------------------------------------------------------

export function makeRunawayStreamWithIds(toolName: string): ModelClientPort {
  let round = 0;
  return {
    streamTurn: async function* ({ signal }): AsyncIterable<ModelStreamChunk> {
      if (signal.aborted) return;
      const id = `tc-round-${round++}`;
      yield { type: "text_delta", textDelta: `Round ${round}: calling ${toolName}` };
      yield { type: "tool_call_start", toolCallId: id, toolName };
      yield { type: "tool_call_end", toolCallId: id };
      yield {
        type: "message_end",
        stopReason: "tool_use",
        usage: { inputTokens: 30, outputTokens: 10 },
      };
    },
  };
}
