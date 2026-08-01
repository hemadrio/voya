/**
 * Versioned streaming event contract for the AI assistant chat endpoint (WO-058).
 *
 * Event names, field names, and field types are additive-only after release.
 * Breaking changes require bumping STREAMING_VERSION and treating the new
 * version as a new event family.
 *
 * Every sink event is a discriminated union on the `type` field so consumers
 * can narrow safely.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Contract version — clients read this from message_start to negotiate
// ---------------------------------------------------------------------------

export const STREAMING_VERSION = "1" as const;

// ---------------------------------------------------------------------------
// Individual event schemas
// ---------------------------------------------------------------------------

export const MessageStartEventSchema = z.object({
  type: z.literal("message_start"),
  /** Identifies this event contract version for client negotiation. */
  version: z.string().default(STREAMING_VERSION),
  /** Server-assigned turn identifier (UUID). Also used as the idempotency key base. */
  turnId: z.string(),
  conversationId: z.string(),
});

export const TextDeltaEventSchema = z.object({
  type: z.literal("text_delta"),
  /** Incremental text content from the model. */
  text: z.string(),
});

export const ToolStartEventSchema = z.object({
  type: z.literal("tool_start"),
  /** Stable per-call identifier assigned by the model. */
  toolCallId: z.string(),
  /** Registered tool name (e.g. "search_flights"). */
  tool: z.string(),
});

export const ToolEndEventSchema = z.object({
  type: z.literal("tool_end"),
  toolCallId: z.string(),
  status: z.enum(["success", "failure"]),
  /** Brief summary of the tool result — safe to display, no raw upstream data. */
  summary: z.unknown().optional(),
});

export const OfferCardEventSchema = z.object({
  type: z.literal("offer_card"),
  /** Unique offer reference matching a ledger entry (never model-generated). */
  offerId: z.string(),
  /** Upstream supplier/provenance string (e.g. "AMADEUS"). */
  provenance: z.string(),
  /** Registered tool name that produced this offer. */
  tool: z.string().optional(),
  /** ISO 4217 currency code for the price snapshot. */
  currency: z.string().optional(),
  /** Price snapshot from the ledger (exact numeric value). */
  price: z.number().optional(),
  /** Epoch milliseconds when the offer was retrieved. */
  retrievedAt: z.number().int().optional(),
  /** True when the offer is older than the configured freshness window. */
  stale: z.boolean().optional(),
  displayTitle: z.string().optional(),
  displaySummary: z.string().optional(),
});

export const MessageEndEventSchema = z.object({
  type: z.literal("message_end"),
  turnId: z.string(),
  /** "refused" is emitted when the safety layer refuses the request (WO-061). */
  status: z.enum(["complete", "incomplete", "refused"]),
  tokenUsage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
  /** Grounding references for persisting with the turn (WO-060). */
  groundingRefs: z
    .array(
      z.object({
        offerRef: z.string(),
        tool: z.string(),
        supplier: z.string(),
        retrievedAt: z.number().int(),
        price: z.number(),
        currency: z.string(),
      }),
    )
    .optional(),
});

export const StreamErrorEventSchema = z.object({
  type: z.literal("error"),
  /** Machine-readable error code — never a provider or model code. */
  code: z.string(),
  /** User-safe message — no stack traces, prompt content, or provider bodies. */
  message: z.string(),
  /** Trace / correlation reference for support triage. */
  reference: z.string(),
});

// ---------------------------------------------------------------------------
// Discriminated union of all sink events
// ---------------------------------------------------------------------------

export const SinkEventSchema = z.discriminatedUnion("type", [
  MessageStartEventSchema,
  TextDeltaEventSchema,
  ToolStartEventSchema,
  ToolEndEventSchema,
  OfferCardEventSchema,
  MessageEndEventSchema,
  StreamErrorEventSchema,
]);

export type MessageStartEvent = z.infer<typeof MessageStartEventSchema>;
export type TextDeltaEvent = z.infer<typeof TextDeltaEventSchema>;
export type ToolStartEvent = z.infer<typeof ToolStartEventSchema>;
export type ToolEndEvent = z.infer<typeof ToolEndEventSchema>;
export type OfferCardEvent = z.infer<typeof OfferCardEventSchema>;
export type MessageEndEvent = z.infer<typeof MessageEndEventSchema>;
export type StreamErrorEvent = z.infer<typeof StreamErrorEventSchema>;
export type SinkEvent = z.infer<typeof SinkEventSchema>;

// ---------------------------------------------------------------------------
// Non-streaming JSON response shape (same logical payload)
// ---------------------------------------------------------------------------

export const ChatNonStreamResponseSchema = z.object({
  turnId: z.string(),
  conversationId: z.string(),
  /** Accumulated text content from all text_delta events. */
  content: z.string(),
  toolCalls: z.array(
    z.object({
      toolCallId: z.string(),
      tool: z.string(),
      status: z.enum(["success", "failure"]),
      summary: z.unknown().optional(),
    }),
  ),
  offerCards: z.array(
    z.object({
      offerId: z.string(),
      provenance: z.string(),
      displayTitle: z.string().optional(),
      displaySummary: z.string().optional(),
    }),
  ),
  tokenUsage: z
    .object({ inputTokens: z.number().int(), outputTokens: z.number().int() })
    .optional(),
  status: z.enum(["complete", "incomplete"]),
});

export type ChatNonStreamResponse = z.infer<typeof ChatNonStreamResponseSchema>;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

export const ChatRequestSchema = z
  .object({
    /** The user's message content. */
    content: z.string().min(1).max(32_000),
    /**
     * Client-supplied turn identifier (UUID) used to derive the idempotency
     * key for persistence. Repeated requests with the same clientTurnId are
     * idempotent.
     */
    clientTurnId: z.string().uuid(),
    /** When true, responds with text/event-stream regardless of Accept header. */
    stream: z.boolean().optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
