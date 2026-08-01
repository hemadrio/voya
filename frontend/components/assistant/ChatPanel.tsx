/**
 * ChatPanel — top-level container for the assistant chat experience (WO-062).
 *
 * Wires together MessageThread and ChatComposer via the useAssistantStream hook.
 * Handles the streaming lifecycle: send, cancel, reconnect, and fallback.
 */

"use client";

import * as React from "react";
import { useAssistantStream } from "@/lib/assistant/useAssistantStream.js";
import { MessageThread } from "./MessageThread.js";
import { ChatComposer } from "./ChatComposer.js";

export interface ChatPanelProps {
  /** Pre-existing conversation ID to resume (optional). */
  conversationId?: string | undefined;
  className?: string | undefined;
}

export function ChatPanel({ conversationId, className }: ChatPanelProps): React.ReactElement {
  const { state, sendMessage, cancelStream } = useAssistantStream();

  const handleSend = React.useCallback(
    (content: string) => {
      void sendMessage(content, conversationId);
    },
    [sendMessage, conversationId],
  );

  return (
    <div
      className={`flex flex-col h-full min-h-0 bg-white ${className ?? ""}`}
      aria-label="AI Travel Assistant"
    >
      {/* Header */}
      <header className="flex-shrink-0 px-4 py-3 border-b border-neutral-200 flex items-center gap-2">
        <div className="h-7 w-7 rounded-full bg-brand-600 flex items-center justify-center" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="white" className="h-4 w-4">
            <path d="M2 5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V5z" />
            <path d="M15 7v2a4 4 0 01-4 4H9.828l-1.766 1.767c.28.149.599.233.938.233h2l3 3v-3h2a2 2 0 002-2V9a2 2 0 00-2-2h-1z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-neutral-900">Travel Assistant</p>
          <p className="text-xs text-neutral-500">
            {state.isStreaming ? "Responding…" : "Ready to help"}
          </p>
        </div>
      </header>

      {/* Message thread — scrollable */}
      <MessageThread state={state} />

      {/* Composer — fixed at bottom */}
      <ChatComposer
        isStreaming={state.isStreaming}
        isDisabled={state.rateLimitRetryAfter !== null}
        onSend={handleSend}
        onCancel={cancelStream}
      />
    </div>
  );
}
