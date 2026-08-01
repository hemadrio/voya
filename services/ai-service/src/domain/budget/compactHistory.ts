/**
 * compactHistory — deterministic history trimming for the token budget (WO-059).
 *
 * Drops the oldest non-essential messages from the history array until the
 * estimated token count falls below the budget.  Always retains:
 *   - The system-like preamble (the first non-user/non-assistant message OR
 *     any message whose role is not "user" / "assistant" / "tool").
 *   - The resolved-slots summary (first assistant message whose content begins
 *     with the SLOTS_SUMMARY_PREFIX sentinel).
 *   - The last user message (the request being processed this turn).
 *
 * Returns a new array (never mutates the input).
 *
 * Throws CompactionError when further dropping would remove a protected
 * message, meaning the history is irreducibly too large.
 */

import type { ModelMessage } from "../orchestrator/ConversationOrchestrator.js";
import { estimateMessagesTokens } from "./estimateTokens.js";

// ---------------------------------------------------------------------------
// Sentinel prefix for the resolved-slots summary injected by the orchestrator
// ---------------------------------------------------------------------------

export const SLOTS_SUMMARY_PREFIX = "[RESOLVED_SLOTS]";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CompactionError extends Error {
  constructor(
    message: string,
    public readonly reason: "OVERSIZED_AFTER_COMPACTION" | "SINGLE_USER_MESSAGE_TOO_LARGE",
  ) {
    super(message);
    this.name = "CompactionError";
  }
}

// ---------------------------------------------------------------------------
// isProtected — returns true for messages that must never be dropped
// ---------------------------------------------------------------------------

function isProtected(msg: ModelMessage, indexInOriginal: number, messages: ReadonlyArray<ModelMessage>): boolean {
  // System / preamble: first message that is not user/assistant/tool role
  if (!["user", "assistant", "tool"].includes(msg.role)) return true;

  // Resolved-slots summary (assistant message with the sentinel prefix)
  if (msg.role === "assistant" && msg.content.startsWith(SLOTS_SUMMARY_PREFIX)) return true;

  // The very last user message
  const lastUserIndex = findLastIndex(messages, (m) => m.role === "user");
  if (indexInOriginal === lastUserIndex) return true;

  return false;
}

function findLastIndex<T>(arr: ReadonlyArray<T>, predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// compactHistory
// ---------------------------------------------------------------------------

/**
 * Compacts `messages` until `estimateMessagesTokens(result) <= tokenBudget`.
 *
 * @param messages    The full history array (not mutated).
 * @param tokenBudget Maximum acceptable estimated input tokens for the history.
 * @returns           A new, potentially shorter array.
 * @throws            CompactionError if budget cannot be met without removing
 *                    a protected message.
 */
export function compactHistory(
  messages: ReadonlyArray<ModelMessage>,
  tokenBudget: number,
): ModelMessage[] {
  if (estimateMessagesTokens(messages) <= tokenBudget) {
    return [...messages];
  }

  // Check if even a single user message alone would exceed the budget
  const lastUserMsg = messages[findLastIndex(messages, (m) => m.role === "user")];
  if (lastUserMsg && estimateMessagesTokens([lastUserMsg]) > tokenBudget) {
    throw new CompactionError(
      `The latest user message alone (${lastUserMsg.content.length} chars) exceeds the input token budget (${tokenBudget} tokens). Start a new conversation.`,
      "SINGLE_USER_MESSAGE_TOO_LARGE",
    );
  }

  // Build working copy — we will drop from the front, skipping protected slots
  const working: Array<ModelMessage & { _originalIndex: number }> = messages.map((m, i) => ({
    ...m,
    _originalIndex: i,
  }));

  while (estimateMessagesTokens(working) > tokenBudget) {
    // Find the first non-protected message
    const dropIdx = working.findIndex(
      (m) => !isProtected(m, m._originalIndex, messages),
    );

    if (dropIdx === -1) {
      // All remaining messages are protected — cannot compact further
      throw new CompactionError(
        `History cannot be compacted below ${tokenBudget} tokens without removing protected messages (system prompt, slots summary, or latest user message). Current estimate: ${estimateMessagesTokens(working)} tokens.`,
        "OVERSIZED_AFTER_COMPACTION",
      );
    }

    working.splice(dropIdx, 1);
  }

  return working.map(({ _originalIndex: _i, ...rest }) => rest);
}
