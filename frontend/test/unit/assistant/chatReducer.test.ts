/**
 * Unit tests for chatReducer (WO-062 AC11).
 *
 * Covers:
 *   - USER_MESSAGE_SENT: optimistic turn added
 *   - text_delta: text accumulated
 *   - tool_start / tool_end: activity tracked
 *   - offer_card: cards appended, idempotent
 *   - message_end: status settled, isStreaming cleared
 *   - message_end duplicate: idempotent
 *   - error event: error state recorded
 *   - CANCEL: active turn marked cancelled
 *   - HISTORY_RECONCILED: server turns merged, streaming turns cancelled
 *   - FALLBACK_RESPONSE: non-streaming response applied
 *   - RATE_LIMITED / CLEAR_RATE_LIMIT
 */

import { describe, it, expect } from "vitest";
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from "../../../lib/assistant/chatReducer.js";
import {
  EVENT_MESSAGE_START,
  EVENT_TOOL_START_FLIGHTS,
  EVENT_TOOL_END_SUCCESS,
  EVENT_TOOL_END_FAILURE,
  EVENT_TEXT_DELTA_1,
  EVENT_TEXT_DELTA_2,
  EVENT_OFFER_CARD_FRESH,
  EVENT_OFFER_CARD_STALE,
  EVENT_MESSAGE_END_COMPLETE,
  EVENT_STREAM_ERROR,
  FIXTURE_NON_STREAMING_RESPONSE,
  FIXTURE_HISTORY_RESPONSE,
  SYNTH_CONVERSATION_ID,
  SYNTH_TURN_ID,
  SYNTH_CLIENT_TURN_ID,
  SYNTH_OFFER_ID_1,
  SYNTH_OFFER_ID_2,
  SYNTH_TOOL_CALL_ID_1,
} from "../../fixtures/assistant.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateWithActiveStreaming(): ChatState {
  let s = initialChatState;
  s = chatReducer(s, {
    type: "USER_MESSAGE_SENT",
    content: "Find flights",
    clientTurnId: SYNTH_CLIENT_TURN_ID,
    conversationId: SYNTH_CONVERSATION_ID,
  });
  s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_MESSAGE_START });
  return s;
}

// ---------------------------------------------------------------------------
// USER_MESSAGE_SENT
// ---------------------------------------------------------------------------

describe("USER_MESSAGE_SENT", () => {
  it("adds an optimistic turn with status streaming", () => {
    const s = chatReducer(initialChatState, {
      type: "USER_MESSAGE_SENT",
      content: "Find me a flight",
      clientTurnId: SYNTH_CLIENT_TURN_ID,
      conversationId: SYNTH_CONVERSATION_ID,
    });
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.status).toBe("streaming");
    expect(s.turns[0]?.userContent).toBe("Find me a flight");
    expect(s.isStreaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message_start
// ---------------------------------------------------------------------------

describe("STREAM_EVENT — message_start", () => {
  it("patches the optimistic turn with the server turnId", () => {
    const s = stateWithActiveStreaming();
    expect(s.activeTurnId).toBe(SYNTH_TURN_ID);
    expect(s.turns[0]?.turnId).toBe(SYNTH_TURN_ID);
  });
});

// ---------------------------------------------------------------------------
// text_delta
// ---------------------------------------------------------------------------

describe("STREAM_EVENT — text_delta", () => {
  it("accumulates text deltas onto the active turn", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TEXT_DELTA_1 });
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TEXT_DELTA_2 });
    expect(s.turns[0]?.assistantText).toBe(
      EVENT_TEXT_DELTA_1.text + EVENT_TEXT_DELTA_2.text,
    );
  });

  it("ignores text_delta when there is no active turn", () => {
    const s = chatReducer(initialChatState, {
      type: "STREAM_EVENT",
      event: EVENT_TEXT_DELTA_1,
    });
    expect(s).toStrictEqual(initialChatState);
  });
});

// ---------------------------------------------------------------------------
// tool_start / tool_end
// ---------------------------------------------------------------------------

describe("STREAM_EVENT — tool_start", () => {
  it("adds a running tool activity entry", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TOOL_START_FLIGHTS });
    expect(s.turns[0]?.toolActivity).toHaveLength(1);
    expect(s.turns[0]?.toolActivity[0]?.status).toBe("running");
    expect(s.turns[0]?.toolActivity[0]?.tool).toBe("search_flights");
  });

  it("is idempotent for duplicate tool_start events", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TOOL_START_FLIGHTS });
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TOOL_START_FLIGHTS });
    expect(s.turns[0]?.toolActivity).toHaveLength(1);
  });
});

describe("STREAM_EVENT — tool_end", () => {
  it("marks tool activity as success", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TOOL_START_FLIGHTS });
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TOOL_END_SUCCESS });
    expect(s.turns[0]?.toolActivity[0]?.status).toBe("success");
  });

  it("marks tool activity as failure", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TOOL_START_FLIGHTS });
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TOOL_END_FAILURE });
    expect(s.turns[0]?.toolActivity[0]?.status).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// offer_card
// ---------------------------------------------------------------------------

describe("STREAM_EVENT — offer_card", () => {
  it("appends offer cards from structured payload", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_OFFER_CARD_FRESH });
    expect(s.turns[0]?.offerCards).toHaveLength(1);
    expect(s.turns[0]?.offerCards[0]?.offerId).toBe(SYNTH_OFFER_ID_1);
    expect(s.turns[0]?.offerCards[0]?.price).toBe(489);
  });

  it("is idempotent for duplicate offer IDs", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_OFFER_CARD_FRESH });
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_OFFER_CARD_FRESH });
    expect(s.turns[0]?.offerCards).toHaveLength(1);
  });

  it("tracks the stale flag from the payload", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_OFFER_CARD_STALE });
    expect(s.turns[0]?.offerCards[0]?.stale).toBe(true);
    expect(s.turns[0]?.offerCards[0]?.offerId).toBe(SYNTH_OFFER_ID_2);
  });
});

// ---------------------------------------------------------------------------
// message_end
// ---------------------------------------------------------------------------

describe("STREAM_EVENT — message_end", () => {
  it("marks the turn as complete and clears streaming state", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_MESSAGE_END_COMPLETE });
    expect(s.isStreaming).toBe(false);
    expect(s.activeTurnId).toBeNull();
    expect(s.turns[0]?.status).toBe("complete");
  });

  it("is idempotent for duplicate message_end events", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_MESSAGE_END_COMPLETE });
    const stateAfterFirst = s;
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_MESSAGE_END_COMPLETE });
    expect(s).toStrictEqual(stateAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// error event
// ---------------------------------------------------------------------------

describe("STREAM_EVENT — error", () => {
  it("marks the active turn as error and stores error details", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_STREAM_ERROR });
    expect(s.turns[0]?.status).toBe("error");
    expect(s.turns[0]?.error?.code).toBe("PROVIDER_ERROR");
    expect(s.turns[0]?.error?.reference).toBeTruthy();
    expect(s.isStreaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CANCEL
// ---------------------------------------------------------------------------

describe("CANCEL", () => {
  it("marks the active streaming turn as cancelled and clears streaming state", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TEXT_DELTA_1 });
    s = chatReducer(s, { type: "CANCEL" });
    expect(s.isStreaming).toBe(false);
    expect(s.activeTurnId).toBeNull();
    expect(s.turns[0]?.status).toBe("cancelled");
  });

  it("retains partial text on cancellation", () => {
    let s = stateWithActiveStreaming();
    s = chatReducer(s, { type: "STREAM_EVENT", event: EVENT_TEXT_DELTA_1 });
    s = chatReducer(s, { type: "CANCEL" });
    expect(s.turns[0]?.assistantText).toBe(EVENT_TEXT_DELTA_1.text);
  });

  it("is a no-op when there is no active turn", () => {
    const s = chatReducer(initialChatState, { type: "CANCEL" });
    expect(s).toStrictEqual(initialChatState);
  });
});

// ---------------------------------------------------------------------------
// HISTORY_RECONCILED
// ---------------------------------------------------------------------------

describe("HISTORY_RECONCILED", () => {
  it("merges server turns and cancels any locally-streaming turns", () => {
    let s = stateWithActiveStreaming();
    const serverTurns = [
      {
        turnId: SYNTH_TURN_ID,
        clientTurnId: SYNTH_TURN_ID,
        conversationId: SYNTH_CONVERSATION_ID,
        userContent: "",
        assistantText: "Server completed text",
        status: "complete" as const,
        toolActivity: [],
        offerCards: [],
      },
    ];
    s = chatReducer(s, { type: "HISTORY_RECONCILED", turns: serverTurns });
    expect(s.isStreaming).toBe(false);
    expect(s.turns[0]?.status).toBe("complete");
    expect(s.turns[0]?.assistantText).toBe("Server completed text");
  });

  it("does not duplicate a turn that exists on both client and server", () => {
    let s = stateWithActiveStreaming();
    const serverTurns = [
      {
        turnId: SYNTH_TURN_ID,
        clientTurnId: SYNTH_TURN_ID,
        conversationId: SYNTH_CONVERSATION_ID,
        userContent: "",
        assistantText: "completed",
        status: "complete" as const,
        toolActivity: [],
        offerCards: [],
      },
    ];
    s = chatReducer(s, { type: "HISTORY_RECONCILED", turns: serverTurns });
    expect(s.turns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FALLBACK_RESPONSE
// ---------------------------------------------------------------------------

describe("FALLBACK_RESPONSE", () => {
  it("applies a non-streaming JSON response as a complete turn", () => {
    let s = chatReducer(initialChatState, {
      type: "USER_MESSAGE_SENT",
      content: "Find flights",
      clientTurnId: SYNTH_CLIENT_TURN_ID,
      conversationId: SYNTH_CONVERSATION_ID,
    });
    s = chatReducer(s, {
      type: "FALLBACK_RESPONSE",
      response: FIXTURE_NON_STREAMING_RESPONSE,
    });
    expect(s.isStreaming).toBe(false);
    const turn = s.turns.find((t) => t.turnId === SYNTH_TURN_ID);
    expect(turn?.status).toBe("complete");
    expect(turn?.assistantText).toContain("great options");
    expect(turn?.toolActivity[0]?.tool).toBe("search_flights");
  });
});

// ---------------------------------------------------------------------------
// RATE_LIMITED / CLEAR_RATE_LIMIT
// ---------------------------------------------------------------------------

describe("RATE_LIMITED", () => {
  it("stores the retry-after value and clears streaming", () => {
    const s = chatReducer(initialChatState, { type: "RATE_LIMITED", retryAfter: 30 });
    expect(s.rateLimitRetryAfter).toBe(30);
    expect(s.isStreaming).toBe(false);
  });
});

describe("CLEAR_RATE_LIMIT", () => {
  it("clears the rate limit state", () => {
    let s = chatReducer(initialChatState, { type: "RATE_LIMITED", retryAfter: 30 });
    s = chatReducer(s, { type: "CLEAR_RATE_LIMIT" });
    expect(s.rateLimitRetryAfter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseHistory shape
// ---------------------------------------------------------------------------

describe("HISTORY_RECONCILED from real history response", () => {
  it("applies reconciled turns from FIXTURE_HISTORY_RESPONSE shape", () => {
    const turns = FIXTURE_HISTORY_RESPONSE.messages.map((msg) => ({
      turnId: msg.turnId,
      clientTurnId: msg.turnId,
      conversationId: msg.conversationId,
      userContent: "",
      assistantText: msg.content,
      status: "complete" as const,
      toolActivity: [],
      offerCards: [],
    }));
    const s = chatReducer(initialChatState, { type: "HISTORY_RECONCILED", turns });
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.assistantText).toBe("I found some options for your trip.");
  });
});
