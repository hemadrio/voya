/**
 * chatReducer — turn-keyed idempotent state machine for the assistant chat (WO-062).
 *
 * State is keyed by turnId so duplicate or out-of-order events are safe to
 * replay, and history reconciliation after a reconnect is a pure merge
 * operation with no side effects.
 *
 * Security: assistant text is stored verbatim; rendering components must
 * output it as plain text — never as dangerouslySetInnerHTML.
 */

import type {
  SinkEvent,
  ChatNonStreamResponse,
} from "@travel/contracts/assistant";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ToolActivityState {
  toolCallId: string;
  tool: string;
  status: "running" | "success" | "failure";
  summary?: unknown;
}

export interface OfferCardState {
  offerId: string;
  provenance: string;
  tool?: string | undefined;
  currency?: string | undefined;
  price?: number | undefined;
  retrievedAt?: number | undefined;
  stale?: boolean | undefined;
  displayTitle?: string | undefined;
  displaySummary?: string | undefined;
}

export type TurnStatus =
  | "streaming"
  | "complete"
  | "incomplete"
  | "refused"
  | "cancelled"
  | "error";

export interface TurnState {
  turnId: string;
  clientTurnId: string;
  conversationId: string;
  userContent: string;
  assistantText: string;
  status: TurnStatus;
  toolActivity: ToolActivityState[];
  offerCards: OfferCardState[];
  error?: { code: string; message: string; reference: string } | undefined;
}

export interface ChatState {
  conversationId: string | null;
  activeTurnId: string | null;
  turns: TurnState[];
  isStreaming: boolean;
  rateLimitRetryAfter: number | null;
}

export const initialChatState: ChatState = {
  conversationId: null,
  activeTurnId: null,
  turns: [],
  isStreaming: false,
  rateLimitRetryAfter: null,
};

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type ChatAction =
  | { type: "USER_MESSAGE_SENT"; content: string; clientTurnId: string; conversationId: string }
  | { type: "STREAM_EVENT"; event: SinkEvent }
  | { type: "CANCEL" }
  | { type: "HISTORY_RECONCILED"; turns: TurnState[] }
  | { type: "FALLBACK_RESPONSE"; response: ChatNonStreamResponse }
  | { type: "RATE_LIMITED"; retryAfter: number }
  | { type: "CLEAR_RATE_LIMIT" };

// ---------------------------------------------------------------------------
// Reducer helpers
// ---------------------------------------------------------------------------

function updateTurn(
  turns: TurnState[],
  turnId: string,
  updater: (t: TurnState) => TurnState,
): TurnState[] {
  return turns.map((t) => (t.turnId === turnId ? updater(t) : t));
}

function upsertTurn(turns: TurnState[], candidate: TurnState): TurnState[] {
  const idx = turns.findIndex((t) => t.turnId === candidate.turnId);
  if (idx === -1) return [...turns, candidate];
  // Keep client-side fields that the server might not return
  return turns.map((t) => (t.turnId === candidate.turnId ? { ...t, ...candidate } : t));
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "USER_MESSAGE_SENT": {
      const optimisticTurn: TurnState = {
        turnId: action.clientTurnId,
        clientTurnId: action.clientTurnId,
        conversationId: action.conversationId,
        userContent: action.content,
        assistantText: "",
        status: "streaming",
        toolActivity: [],
        offerCards: [],
      };
      return {
        ...state,
        conversationId: action.conversationId,
        activeTurnId: action.clientTurnId,
        isStreaming: true,
        turns: [...state.turns, optimisticTurn],
      };
    }

    case "STREAM_EVENT": {
      const event = action.event;

      switch (event.type) {
        case "message_start": {
          // The server assigns the real turnId; patch the optimistic turn if present
          const existingTurnIdx = state.turns.findIndex(
            (t) =>
              t.turnId === state.activeTurnId ||
              t.conversationId === event.conversationId,
          );
          if (existingTurnIdx !== -1) {
            const updated = state.turns.map((t, i) =>
              i === existingTurnIdx
                ? { ...t, turnId: event.turnId, conversationId: event.conversationId }
                : t,
            );
            return {
              ...state,
              activeTurnId: event.turnId,
              conversationId: event.conversationId,
              turns: updated,
            };
          }
          // Brand-new turn (e.g. from reconnect)
          const newTurn: TurnState = {
            turnId: event.turnId,
            clientTurnId: event.turnId,
            conversationId: event.conversationId,
            userContent: "",
            assistantText: "",
            status: "streaming",
            toolActivity: [],
            offerCards: [],
          };
          return {
            ...state,
            activeTurnId: event.turnId,
            conversationId: event.conversationId,
            turns: [...state.turns, newTurn],
          };
        }

        case "text_delta": {
          if (!state.activeTurnId) return state;
          return {
            ...state,
            turns: updateTurn(state.turns, state.activeTurnId, (t) => ({
              ...t,
              assistantText: t.assistantText + event.text,
            })),
          };
        }

        case "tool_start": {
          if (!state.activeTurnId) return state;
          return {
            ...state,
            turns: updateTurn(state.turns, state.activeTurnId, (t) => {
              // Idempotent: skip if already tracked
              if (t.toolActivity.some((a) => a.toolCallId === event.toolCallId)) return t;
              return {
                ...t,
                toolActivity: [
                  ...t.toolActivity,
                  { toolCallId: event.toolCallId, tool: event.tool, status: "running" },
                ],
              };
            }),
          };
        }

        case "tool_end": {
          if (!state.activeTurnId) return state;
          return {
            ...state,
            turns: updateTurn(state.turns, state.activeTurnId, (t) => ({
              ...t,
              toolActivity: t.toolActivity.map((a) =>
                a.toolCallId === event.toolCallId
                  ? { ...a, status: event.status, summary: event.summary }
                  : a,
              ),
            })),
          };
        }

        case "offer_card": {
          if (!state.activeTurnId) return state;
          return {
            ...state,
            turns: updateTurn(state.turns, state.activeTurnId, (t) => {
              // Idempotent: skip duplicate offer IDs
              if (t.offerCards.some((c) => c.offerId === event.offerId)) return t;
              return {
                ...t,
                offerCards: [
                  ...t.offerCards,
                  {
                    offerId: event.offerId,
                    provenance: event.provenance,
                    tool: event.tool,
                    currency: event.currency,
                    price: event.price,
                    retrievedAt: event.retrievedAt,
                    stale: event.stale,
                    displayTitle: event.displayTitle,
                    displaySummary: event.displaySummary,
                  },
                ],
              };
            }),
          };
        }

        case "message_end": {
          // Idempotent: if already settled, ignore repeat
          const alreadyDone = state.turns.find(
            (t) => t.turnId === event.turnId && t.status !== "streaming",
          );
          if (alreadyDone) return state;

          const statusMap: Record<string, TurnStatus> = {
            complete: "complete",
            incomplete: "incomplete",
            refused: "refused",
          };
          const finalStatus = statusMap[event.status] ?? "incomplete";

          return {
            ...state,
            isStreaming: false,
            activeTurnId: null,
            turns: updateTurn(state.turns, event.turnId, (t) => ({
              ...t,
              status: finalStatus,
            })),
          };
        }

        case "error": {
          if (!state.activeTurnId) return state;
          return {
            ...state,
            isStreaming: false,
            activeTurnId: null,
            turns: updateTurn(state.turns, state.activeTurnId, (t) => ({
              ...t,
              status: "error",
              error: { code: event.code, message: event.message, reference: event.reference },
            })),
          };
        }

        default:
          return state;
      }
    }

    case "CANCEL": {
      if (!state.activeTurnId) return state;
      return {
        ...state,
        isStreaming: false,
        activeTurnId: null,
        turns: updateTurn(state.turns, state.activeTurnId, (t) => ({
          ...t,
          status: "cancelled",
        })),
      };
    }

    case "HISTORY_RECONCILED": {
      // Merge server-side turns by turnId; server is authoritative for completed turns
      let merged = [...state.turns];
      for (const serverTurn of action.turns) {
        merged = upsertTurn(merged, serverTurn);
      }
      // Mark any locally-streaming turns as cancelled if the server didn't complete them
      merged = merged.map((t) =>
        t.status === "streaming" ? { ...t, status: "cancelled" } : t,
      );
      return {
        ...state,
        isStreaming: false,
        activeTurnId: null,
        turns: merged,
      };
    }

    case "FALLBACK_RESPONSE": {
      const r = action.response;
      const fallbackTurn: TurnState = {
        turnId: r.turnId,
        clientTurnId: r.turnId,
        conversationId: r.conversationId,
        userContent: "",
        assistantText: r.content,
        status: r.status === "complete" ? "complete" : "incomplete",
        toolActivity: r.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          tool: tc.tool,
          status: tc.status,
          summary: tc.summary,
        })),
        offerCards: r.offerCards.map((oc) => ({
          offerId: oc.offerId,
          provenance: oc.provenance,
          displayTitle: oc.displayTitle,
          displaySummary: oc.displaySummary,
        })),
      };
      return {
        ...state,
        isStreaming: false,
        activeTurnId: null,
        conversationId: r.conversationId,
        turns: upsertTurn(state.turns, fallbackTurn),
      };
    }

    case "RATE_LIMITED":
      return { ...state, isStreaming: false, activeTurnId: null, rateLimitRetryAfter: action.retryAfter };

    case "CLEAR_RATE_LIMIT":
      return { ...state, rateLimitRetryAfter: null };

    default:
      return state;
  }
}
