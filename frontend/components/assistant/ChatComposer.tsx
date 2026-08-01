/**
 * ChatComposer — text input and send/cancel controls for the assistant (WO-062 AC6).
 *
 * Accessibility:
 *   - All controls are keyboard reachable with visible focus styles.
 *   - Send is disabled while streaming; Cancel is shown only while streaming.
 *   - Enter submits (Shift+Enter inserts newline).
 *   - aria-labels on all icon-only controls.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";

export interface ChatComposerProps {
  isStreaming: boolean;
  isDisabled?: boolean | undefined;
  onSend: (content: string) => void;
  onCancel: () => void;
}

export function ChatComposer({
  isStreaming,
  isDisabled = false,
  onSend,
  onCancel,
}: ChatComposerProps): React.ReactElement {
  const [text, setText] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const canSend = text.trim().length > 0 && !isStreaming && !isDisabled;

  const handleSend = (): void => {
    const content = text.trim();
    if (!content) return;
    setText("");
    onSend(content);
    // Refocus after send so keyboard users can keep typing
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) handleSend();
    }
  };

  return (
    <div
      className="border-t border-neutral-200 bg-white px-4 py-3"
      role="region"
      aria-label="Chat input"
    >
      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border transition-colors",
          isStreaming ? "border-brand-300 bg-brand-50/30" : "border-neutral-300 bg-white",
          "focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20",
        )}
      >
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none bg-transparent px-3 py-2.5 text-sm text-neutral-900 placeholder-neutral-400 outline-none min-h-[44px] max-h-32 leading-relaxed"
          placeholder={isStreaming ? "Waiting for response…" : "Ask about flights, hotels, or cars…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming || isDisabled}
          aria-label="Message input"
          aria-multiline="true"
          rows={1}
        />

        {/* Cancel button — visible only while streaming */}
        {isStreaming && (
          <button
            type="button"
            className="flex-shrink-0 mb-2 mr-1 h-8 w-8 rounded-lg flex items-center justify-center text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            onClick={onCancel}
            aria-label="Cancel response"
          >
            <StopIcon />
          </button>
        )}

        {/* Send button — disabled while streaming or empty */}
        {!isStreaming && (
          <button
            type="button"
            className={cn(
              "flex-shrink-0 mb-2 mr-1 h-8 w-8 rounded-lg flex items-center justify-center",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              canSend
                ? "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800"
                : "bg-neutral-100 text-neutral-300 cursor-not-allowed",
            )}
            onClick={handleSend}
            disabled={!canSend}
            aria-label="Send message"
            aria-disabled={!canSend}
          >
            <SendIcon />
          </button>
        )}
      </div>

      {/* Keyboard hint */}
      <p className="mt-1.5 text-center text-xs text-neutral-400">
        Press Enter to send · Shift+Enter for new line
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline icons (no external icon library dependency)
// ---------------------------------------------------------------------------

function SendIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
    </svg>
  );
}

function StopIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M2 10a8 8 0 1116 0 8 8 0 01-16 0zm5-2.25A.75.75 0 017.75 7h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-.75.75h-4.5a.75.75 0 01-.75-.75v-4.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}
