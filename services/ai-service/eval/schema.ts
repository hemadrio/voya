/**
 * Scenario schema for the assistant evaluation harness (WO-063).
 *
 * Every scenario file is validated against this schema before execution.
 * Malformed scenarios abort with a specific, actionable error message.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Model stream chunk — mirrors ModelStreamChunk from ConversationOrchestrator
// ---------------------------------------------------------------------------

const ModelStreamChunkSchema = z.object({
  type: z.enum(["text_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "message_end"]),
  textDelta: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  toolInputDelta: z.string().optional(),
  stopReason: z.enum(["end_turn", "tool_use", "max_tokens"]).optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

export type ModelStreamChunk = z.infer<typeof ModelStreamChunkSchema>;

// ---------------------------------------------------------------------------
// Stubbed tool response — pre-recorded per "toolName:callIndex" key
// ---------------------------------------------------------------------------

const StubbedToolResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export type StubbedToolResponse = z.infer<typeof StubbedToolResponseSchema>;

// ---------------------------------------------------------------------------
// Per-turn expectations
// ---------------------------------------------------------------------------

const TurnExpectationsSchema = z.object({
  /** Expected tool names dispatched in this turn (ordered). */
  tools: z.array(z.string()).optional(),
  /** Whether a refusal is expected. */
  refusal: z.boolean().optional(),
  /** Expected RefusalReason code. */
  refusalReason: z.string().optional(),
  grounding: z.object({
    /** Minimum fraction of claims that should be supported (0–1). */
    minPassRate: z.number().min(0).max(1).optional(),
    /** All emitted offer cards must trace to a ledger entry. */
    allOfferCardsTraceable: z.boolean().optional(),
  }).optional(),
  safety: z.object({
    /** No executable markup in output text. */
    expectNoMarkup: z.boolean().optional(),
    /** No system-prompt disclosure. */
    expectNoPromptDisclosure: z.boolean().optional(),
  }).optional(),
  cost: z.object({
    maxTokensIn: z.number().optional(),
    maxTokensOut: z.number().optional(),
    maxToolCalls: z.number().optional(),
  }).optional(),
  latency: z.object({
    maxFirstEventMs: z.number().optional(),
    maxTotalMs: z.number().optional(),
  }).optional(),
}).optional();

export type TurnExpectations = z.infer<typeof TurnExpectationsSchema>;

// ---------------------------------------------------------------------------
// Scenario turn
// ---------------------------------------------------------------------------

const ScenarioTurnSchema = z.object({
  userContent: z.string().min(1),
  /**
   * Stubbed tool responses keyed by "toolName:callIndex" (e.g. "search_flights:0").
   * Call index is 0-based per tool name.
   */
  stubbedToolResponses: z.record(StubbedToolResponseSchema).default({}),
  /**
   * Scripted model rounds. Each round is one streamTurn() call.
   * Multi-round scenarios simulate tool-use loops.
   */
  scriptedModelTranscript: z.array(z.array(ModelStreamChunkSchema)).min(1),
  expectations: TurnExpectationsSchema,
  /** Optional: override freshnessWindowMs for this turn (e.g. 0 to force stale). */
  freshnessWindowMs: z.number().optional(),
});

export type ScenarioTurn = z.infer<typeof ScenarioTurnSchema>;

// ---------------------------------------------------------------------------
// Top-level scenario
// ---------------------------------------------------------------------------

export const ScenarioSchema = z.object({
  version: z.literal("1"),
  id: z.string().regex(/^sc-\d{3}$/, "Scenario IDs must match sc-NNN"),
  description: z.string().min(5),
  principalType: z.enum(["traveler", "guest"]),
  turns: z.array(ScenarioTurnSchema).min(1),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

// ---------------------------------------------------------------------------
// Validate a scenario from a raw JSON object
// ---------------------------------------------------------------------------

export function validateScenario(raw: unknown, filename: string): Scenario {
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid scenario in ${filename}:\n${issues}`);
  }
  return result.data;
}
