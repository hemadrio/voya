/**
 * useAssistantStream — fetch-based SSE streaming hook for the assistant chat (WO-062).
 *
 * Uses fetch + ReadableStream + AbortController instead of EventSource so
 * POST bodies and auth headers are supported.
 *
 * Flow:
 *   1. Build chat request, open POST with Accept: text/event-stream
 *   2. Parse SSE frames line-by-line
 *   3. Validate each parsed JSON against SinkEventSchema
 *   4. Dispatch validated events to chatReducer
 *   5. On stream error: attempt one reconnect via history refetch + reconcile
 *   6. On streaming unavailable: fall back to non-streaming JSON response
 *
 * Security:
 *   - Never stores or surfaces raw assistant text as HTML
 *   - Auth header attached from session cookie (HttpOnly — browser sends automatically)
 */

"use client";

import { useReducer, useCallback, useRef } from "react";
import {
  SinkEventSchema,
  ChatNonStreamResponseSchema,
} from "@travel/contracts/assistant";
import {
  chatReducer,
  initialChatState,
  type ChatState,
  type TurnState,
} from "./chatReducer.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:4000/api/v1";

// ---------------------------------------------------------------------------
// SSE frame parser
// ---------------------------------------------------------------------------

/**
 * Parse a chunk of SSE text into an array of event data strings.
 * Ignores comment lines (starting with ':') used for heartbeats.
 * Each 'data:' line is yielded as a string.
 */
function* parseSseChunk(chunk: string): Generator<string> {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        yield payload;
      }
    }
    // Ignore comment/heartbeat lines (start with ':') per SSE spec
  }
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface UseAssistantStreamReturn {
  state: ChatState;
  sendMessage: (content: string, conversationId?: string) => Promise<void>;
  cancelStream: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAssistantStream(): UseAssistantStreamReturn {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const abortRef = useRef<AbortController | null>(null);

  const cancelStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    dispatch({ type: "CANCEL" });
  }, []);

  const sendMessage = useCallback(
    async (content: string, conversationId?: string) => {
      const convId = conversationId ?? state.conversationId ?? `conv-${crypto.randomUUID()}`;
      const clientTurnId = crypto.randomUUID();

      // Abort any prior in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;

      dispatch({ type: "USER_MESSAGE_SENT", content, clientTurnId, conversationId: convId });

      const url = `${API_BASE}/assistant/conversations/${convId}/messages`;
      const body = JSON.stringify({ content, clientTurnId, stream: true });

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body,
          signal: controller.signal,
          credentials: "include",
        });

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get("Retry-After") ?? "60", 10);
          dispatch({ type: "RATE_LIMITED", retryAfter });
          return;
        }

        // Check if the server supports streaming
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          // Non-streaming path: parse as JSON
          const json: unknown = await response.json();
          const parsed = ChatNonStreamResponseSchema.safeParse(json);
          if (parsed.success) {
            dispatch({ type: "FALLBACK_RESPONSE", response: parsed.data });
          }
          return;
        }

        if (!response.body) {
          throw new Error("Response body is null");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Split on double-newline (SSE event boundary)
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";

            for (const part of parts) {
              for (const dataStr of parseSseChunk(part)) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(dataStr);
                } catch {
                  continue; // Ignore malformed JSON — forward-compatible
                }
                const result = SinkEventSchema.safeParse(parsed);
                if (result.success) {
                  dispatch({ type: "STREAM_EVENT", event: result.data });
                }
                // Unrecognised event types are silently ignored (forward-compatible)
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // User-initiated cancel — already dispatched CANCEL, nothing more to do
          return;
        }

        // Network error — attempt one reconcile-from-history, then fall back
        await reconcileFromHistory(convId, dispatch);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [state.conversationId],
  );

  return { state, sendMessage, cancelStream };
}

// ---------------------------------------------------------------------------
// Reconnect: refetch history and reconcile
// ---------------------------------------------------------------------------

async function reconcileFromHistory(
  conversationId: string,
  dispatch: React.Dispatch<import("./chatReducer.js").ChatAction>,
): Promise<void> {
  try {
    const historyUrl = `${API_BASE}/assistant/conversations/${conversationId}`;
    const historyRes = await fetch(historyUrl, { credentials: "include" });
    if (!historyRes.ok) {
      dispatch({ type: "CANCEL" });
      return;
    }

    const historyJson: unknown = await historyRes.json();
    const serverTurns = parseHistoryToTurns(historyJson);
    dispatch({ type: "HISTORY_RECONCILED", turns: serverTurns });
  } catch {
    // Reconcile failed — fall through to cancelled state
    dispatch({ type: "CANCEL" });
  }
}

/**
 * Convert the server history response to the client TurnState shape.
 * Uses a best-effort parse — unrecognised fields are ignored.
 */
function parseHistoryToTurns(json: unknown): TurnState[] {
  if (typeof json !== "object" || json === null) return [];
  const root = json as Record<string, unknown>;
  const messages = root["messages"];
  if (!Array.isArray(messages)) return [];

  const turns: TurnState[] = [];
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Record<string, unknown>;
    const turnId = typeof m["turnId"] === "string" ? m["turnId"] : undefined;
    const convId = typeof m["conversationId"] === "string" ? m["conversationId"] : "";
    const content = typeof m["content"] === "string" ? m["content"] : "";
    const status = typeof m["status"] === "string" ? m["status"] : "complete";

    if (!turnId) continue;
    turns.push({
      turnId,
      clientTurnId: turnId,
      conversationId: convId,
      userContent: "",
      assistantText: content,
      status: status as TurnState["status"],
      toolActivity: [],
      offerCards: [],
    });
  }
  return turns;
}
