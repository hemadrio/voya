/**
 * Assistant SSE event stream fixtures (WO-062, AC13).
 *
 * Committed fixtures covering:
 *   FIXTURE_STREAM_HAPPY_PATH       — multi-tool turn with offer cards
 *   FIXTURE_STREAM_MID_ERROR        — mid-stream error event
 *   FIXTURE_STREAM_STALE_OFFER      — offer card with stale=true
 *   FIXTURE_STREAM_ABORTED          — partial turn (simulates abort)
 *   FIXTURE_STREAM_RATE_LIMITED     — HTTP 429 response
 *   FIXTURE_NON_STREAMING_RESPONSE  — non-streaming fallback JSON
 *   FIXTURE_HISTORY_RESPONSE        — GET /conversations/:id response
 *
 * All content is synthetic. No real supplier data, prices, or identifiers.
 */

import type {
  MessageStartEvent,
  TextDeltaEvent,
  ToolStartEvent,
  ToolEndEvent,
  OfferCardEvent,
  MessageEndEvent,
  StreamErrorEvent,
  ChatNonStreamResponse,
} from "@travel/contracts/assistant";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

export const SYNTH_CONVERSATION_ID = "cc000001-0000-4000-8000-000000000001";
export const SYNTH_TURN_ID = "tt000001-0000-4000-8000-000000000001";
export const SYNTH_CLIENT_TURN_ID = "ct000001-0000-4000-8000-000000000001";
export const SYNTH_TOOL_CALL_ID_1 = "tc000001-0000-4000-8000-000000000001";
export const SYNTH_TOOL_CALL_ID_2 = "tc000001-0000-4000-8000-000000000002";
export const SYNTH_OFFER_ID_1 = "offer-synth-001";
export const SYNTH_OFFER_ID_2 = "offer-synth-002";
export const SYNTH_REFERENCE = "ref-synth-00001";

// ---------------------------------------------------------------------------
// Individual events
// ---------------------------------------------------------------------------

export const EVENT_MESSAGE_START: MessageStartEvent = {
  type: "message_start",
  version: "1",
  turnId: SYNTH_TURN_ID,
  conversationId: SYNTH_CONVERSATION_ID,
};

export const EVENT_TOOL_START_FLIGHTS: ToolStartEvent = {
  type: "tool_start",
  toolCallId: SYNTH_TOOL_CALL_ID_1,
  tool: "search_flights",
};

export const EVENT_TOOL_START_HOTELS: ToolStartEvent = {
  type: "tool_start",
  toolCallId: SYNTH_TOOL_CALL_ID_2,
  tool: "search_hotels",
};

export const EVENT_TOOL_END_SUCCESS: ToolEndEvent = {
  type: "tool_end",
  toolCallId: SYNTH_TOOL_CALL_ID_1,
  status: "success",
  summary: "Found 5 flights from LHR to JFK",
};

export const EVENT_TOOL_END_HOTELS_SUCCESS: ToolEndEvent = {
  type: "tool_end",
  toolCallId: SYNTH_TOOL_CALL_ID_2,
  status: "success",
  summary: "Found 3 hotels in Manhattan",
};

export const EVENT_TOOL_END_FAILURE: ToolEndEvent = {
  type: "tool_end",
  toolCallId: SYNTH_TOOL_CALL_ID_1,
  status: "failure",
  summary: "Search timed out",
};

export const EVENT_TEXT_DELTA_1: TextDeltaEvent = {
  type: "text_delta",
  text: "I found some great options for your trip. ",
};

export const EVENT_TEXT_DELTA_2: TextDeltaEvent = {
  type: "text_delta",
  text: "Here are the best available flights:",
};

export const EVENT_OFFER_CARD_FRESH: OfferCardEvent = {
  type: "offer_card",
  offerId: SYNTH_OFFER_ID_1,
  provenance: "AMADEUS",
  tool: "search_flights",
  currency: "USD",
  price: 489,
  retrievedAt: Date.now() - 60_000, // 1 minute ago — fresh
  stale: false,
  displayTitle: "LHR → JFK — Economy",
  displaySummary: "Departs 08:00, arrives 11:30 · 7h 30m · 1 stop",
};

export const EVENT_OFFER_CARD_STALE: OfferCardEvent = {
  type: "offer_card",
  offerId: SYNTH_OFFER_ID_2,
  provenance: "AMADEUS",
  tool: "search_flights",
  currency: "USD",
  price: 412,
  retrievedAt: Date.now() - 10 * 60_000, // 10 minutes ago — stale
  stale: true,
  displayTitle: "LHR → JFK — Economy (stale)",
  displaySummary: "Price may have changed",
};

export const EVENT_MESSAGE_END_COMPLETE: MessageEndEvent = {
  type: "message_end",
  turnId: SYNTH_TURN_ID,
  status: "complete",
  tokenUsage: { inputTokens: 120, outputTokens: 85 },
};

export const EVENT_MESSAGE_END_INCOMPLETE: MessageEndEvent = {
  type: "message_end",
  turnId: SYNTH_TURN_ID,
  status: "incomplete",
};

export const EVENT_STREAM_ERROR: StreamErrorEvent = {
  type: "error",
  code: "PROVIDER_ERROR",
  message: "The assistant encountered a problem. Please try again.",
  reference: SYNTH_REFERENCE,
};

// ---------------------------------------------------------------------------
// Complete event sequences encoded as SSE text
// ---------------------------------------------------------------------------

function toSseLine(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Happy path: two tools then text then an offer card */
export const FIXTURE_STREAM_HAPPY_PATH: string =
  toSseLine(EVENT_MESSAGE_START) +
  toSseLine(EVENT_TOOL_START_FLIGHTS) +
  toSseLine(EVENT_TOOL_END_SUCCESS) +
  toSseLine(EVENT_TEXT_DELTA_1) +
  toSseLine(EVENT_TEXT_DELTA_2) +
  toSseLine(EVENT_OFFER_CARD_FRESH) +
  toSseLine(EVENT_MESSAGE_END_COMPLETE);

/** Mid-stream terminal error */
export const FIXTURE_STREAM_MID_ERROR: string =
  toSseLine(EVENT_MESSAGE_START) +
  toSseLine(EVENT_TOOL_START_FLIGHTS) +
  toSseLine(EVENT_TEXT_DELTA_1) +
  toSseLine(EVENT_STREAM_ERROR);

/** Stale offer card */
export const FIXTURE_STREAM_STALE_OFFER: string =
  toSseLine(EVENT_MESSAGE_START) +
  toSseLine(EVENT_TEXT_DELTA_1) +
  toSseLine(EVENT_OFFER_CARD_STALE) +
  toSseLine(EVENT_MESSAGE_END_COMPLETE);

/** Partial turn (simulates mid-stream abort — no message_end) */
export const FIXTURE_STREAM_ABORTED: string =
  toSseLine(EVENT_MESSAGE_START) +
  toSseLine(EVENT_TOOL_START_FLIGHTS) +
  toSseLine(EVENT_TEXT_DELTA_1);

// ---------------------------------------------------------------------------
// Non-streaming fallback response
// ---------------------------------------------------------------------------

export const FIXTURE_NON_STREAMING_RESPONSE: ChatNonStreamResponse = {
  turnId: SYNTH_TURN_ID,
  conversationId: SYNTH_CONVERSATION_ID,
  content: "I found some great options for your trip. Here are the best available flights:",
  toolCalls: [
    { toolCallId: SYNTH_TOOL_CALL_ID_1, tool: "search_flights", status: "success", summary: "Found 5 flights" },
  ],
  offerCards: [
    {
      offerId: SYNTH_OFFER_ID_1,
      provenance: "AMADEUS",
      displayTitle: "LHR → JFK — Economy",
      displaySummary: "Economy class, 1 stop",
    },
  ],
  tokenUsage: { inputTokens: 120, outputTokens: 85 },
  status: "complete",
};

// ---------------------------------------------------------------------------
// History endpoint response (for reconcile after reconnect)
// ---------------------------------------------------------------------------

export const FIXTURE_HISTORY_RESPONSE = {
  conversationId: SYNTH_CONVERSATION_ID,
  messages: [
    {
      turnId: SYNTH_TURN_ID,
      conversationId: SYNTH_CONVERSATION_ID,
      content: "I found some options for your trip.",
      status: "complete",
    },
  ],
  nextCursor: null,
};

// ---------------------------------------------------------------------------
// HTTP 429 rate-limit response headers
// ---------------------------------------------------------------------------

export const FIXTURE_RATE_LIMIT_HEADERS: Record<string, string> = {
  "Retry-After": "30",
  "Content-Type": "application/json",
};

export const FIXTURE_RATE_LIMIT_BODY = {
  error: {
    code: "RATE_LIMIT_EXCEEDED",
    message: "Too many requests. Please try again shortly.",
    reference: SYNTH_REFERENCE,
  },
};
