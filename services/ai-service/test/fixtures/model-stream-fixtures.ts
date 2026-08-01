/**
 * Deterministic scripted model stream fixtures for WO-058 integration tests.
 *
 * Three fixture generators:
 *   - happyPathStream      — normal turn with one tool call (search_flights)
 *   - midStreamErrorStream — text delta followed by a provider error throw
 *   - stalledStream        — deliberate pause for heartbeat / timeout testing
 *
 * All fixtures implement ModelClientPort.streamTurn so they can be injected
 * into ConversationOrchestrator in tests without a real model.
 */

import type { ModelStreamChunk } from "../../src/domain/orchestrator/ConversationOrchestrator.js";

// ---------------------------------------------------------------------------
// Helper to build a scripted async iterable with optional delays
// ---------------------------------------------------------------------------

async function* scripted(
  items: Array<ModelStreamChunk | { __delay: number }>,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamChunk> {
  for (const item of items) {
    if (signal.aborted) return;
    if ("__delay" in item) {
      await delay(item.__delay, signal);
      continue;
    }
    yield item;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Happy path — text + one tool call + second text + message_end
// ---------------------------------------------------------------------------

export function happyPathStream(signal: AbortSignal): AsyncIterable<ModelStreamChunk> {
  return scripted([
    { type: "text_delta", textDelta: "Let me search for flights for you. " },
    { type: "tool_call_start", toolCallId: "tc-001", toolName: "search_flights" },
    { type: "tool_call_delta", toolCallId: "tc-001", toolInputDelta: '{"origin":"LHR","destination":"LIS"' },
    { type: "tool_call_delta", toolCallId: "tc-001", toolInputDelta: ',"passengers":2}' },
    { type: "tool_call_end", toolCallId: "tc-001" },
    {
      type: "message_end",
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30 },
    },
    // Second round after tool results
    { type: "text_delta", textDelta: "I found several options for you." },
    {
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 80, outputTokens: 20 },
    },
  ], signal);
}

// ---------------------------------------------------------------------------
// Mid-stream error — yields a text delta then throws
// ---------------------------------------------------------------------------

export async function* midStreamErrorStream(signal: AbortSignal): AsyncGenerator<ModelStreamChunk> {
  yield { type: "text_delta", textDelta: "Starting to answer..." };
  if (!signal.aborted) {
    throw new Error("Provider connection reset");
  }
}

// ---------------------------------------------------------------------------
// Stalled stream — yields a start event then waits 2 seconds (heartbeat trigger)
// ---------------------------------------------------------------------------

export function stalledStream(signal: AbortSignal): AsyncIterable<ModelStreamChunk> {
  return scripted([
    { type: "text_delta", textDelta: "Thinking" },
    { __delay: 2_000 },
    { type: "text_delta", textDelta: "..." },
    {
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ], signal);
}

// ---------------------------------------------------------------------------
// Quick empty turn — useful for testing message_start / message_end ordering
// ---------------------------------------------------------------------------

export function emptyTurnStream(signal: AbortSignal): AsyncIterable<ModelStreamChunk> {
  return scripted([
    {
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 0 },
    },
  ], signal);
}
