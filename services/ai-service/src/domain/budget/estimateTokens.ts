/**
 * Token estimation utilities for AI assistant cost accounting (WO-059).
 *
 * Anthropic Claude uses approximately 4 characters per token for typical
 * English text.  We use 3.5 chars/token (~14% safety margin) to ensure
 * estimates are slightly above true token counts, preventing under-budgeting.
 *
 * This is an approximation — actual counts come from the provider response
 * and are used for definitive accounting.  The estimate is used only for
 * pre-call cap checks and history compaction decisions.
 */

import type { ModelMessage } from "../orchestrator/ConversationOrchestrator.js";

// Conservative: ~14% over the true ~4 chars/token average for Claude.
const CHARS_PER_TOKEN = 3.5;
// Per-message overhead in tokens (role label + formatting).
const PER_MESSAGE_OVERHEAD_TOKENS = 4;
// Tool schema overhead per tool (name + description + schema boilerplate).
const PER_TOOL_OVERHEAD_TOKENS = 6;

/**
 * Estimate token count for a single string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate total input tokens for a message array.
 * Accounts for per-message role overhead and a conversation-level formatting
 * constant (3 tokens).
 */
export function estimateMessagesTokens(messages: ReadonlyArray<{ content: string }>): number {
  const messageTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + PER_MESSAGE_OVERHEAD_TOKENS,
    0,
  );
  return messageTokens + 3; // conversation-level constant
}

/**
 * Estimate tokens consumed by tool schema definitions.
 * These tokens are charged in every model call that includes tools.
 */
export function estimateToolSchemasTokens(
  tools: ReadonlyArray<{ name: string; description: string; input_schema: unknown }>,
): number {
  return tools.reduce((sum, t) => {
    const schemaStr = JSON.stringify(t.input_schema ?? {});
    const toolStr = t.name + t.description + schemaStr;
    return sum + estimateTokens(toolStr) + PER_TOOL_OVERHEAD_TOKENS;
  }, 0);
}

/**
 * Estimate total input tokens for a model call: messages + tool schemas.
 */
export function estimateTotalInputTokens(
  messages: ReadonlyArray<ModelMessage>,
  tools: ReadonlyArray<{ name: string; description: string; input_schema: unknown }>,
): number {
  return estimateMessagesTokens(messages) + estimateToolSchemasTokens(tools);
}
