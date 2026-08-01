/**
 * MessageThread — renders the ordered list of conversation turns (WO-062).
 *
 * Accessibility:
 *   - The active streaming bubble uses aria-live="polite" (scoped to that bubble,
 *     not the whole thread, so screen readers announce new text without repeating history).
 *   - The thread itself is a landmark region.
 *
 * Performance:
 *   - History capped at MAX_RENDERED_TURNS to prevent unbounded DOM growth.
 *     Older turns are hidden from the DOM; scroll position is preserved at
 *     the bottom anchor.
 */

"use client";

import * as React from "react";
import type { ChatState } from "@/lib/assistant/chatReducer.js";
import { MessageBubble } from "./MessageBubble.js";

// Cap rendered history to prevent unbounded DOM growth (AC constraint)
const MAX_RENDERED_TURNS = 50;

export interface MessageThreadProps {
  state: ChatState;
}

export function MessageThread({ state }: MessageThreadProps): React.ReactElement {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content arrives
  React.useEffect(() => {
    if (state.isStreaming || state.turns.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [state.turns, state.isStreaming]);

  const visibleTurns = state.turns.slice(-MAX_RENDERED_TURNS);
  const hiddenCount = state.turns.length - visibleTurns.length;

  return (
    <section
      className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6"
      aria-label="Conversation"
      role="log"
      aria-live="off" // Individual bubbles own their aria-live (scoped, not the whole thread)
    >
      {/* Overflow notice */}
      {hiddenCount > 0 && (
        <p className="text-center text-xs text-neutral-400 py-2">
          {hiddenCount} earlier {hiddenCount === 1 ? "message" : "messages"} not shown
        </p>
      )}

      {/* Empty state */}
      {visibleTurns.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-neutral-400">
            Ask me anything about flights, hotels, or car rentals.
          </p>
        </div>
      )}

      {/* Rate limit notice */}
      {state.rateLimitRetryAfter !== null && (
        <div
          className="mx-auto max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 text-center"
          role="alert"
        >
          <p className="font-medium">Too many requests</p>
          <p className="text-xs mt-1">
            Please wait {state.rateLimitRetryAfter} second{state.rateLimitRetryAfter !== 1 ? "s" : ""} before sending another message.
          </p>
        </div>
      )}

      {/* Conversation turns */}
      {visibleTurns.map((turn) => (
        <MessageBubble
          key={turn.turnId}
          turn={turn}
          isActive={turn.turnId === state.activeTurnId}
        />
      ))}

      {/* Scroll anchor */}
      <div ref={bottomRef} aria-hidden="true" />
    </section>
  );
}
