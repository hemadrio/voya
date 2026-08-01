/**
 * MessageBubble — renders one assistant or user turn.
 *
 * Security invariant: assistant text is ALWAYS rendered as a plain text node.
 * dangerouslySetInnerHTML is deliberately absent from this component.
 * Any script markup in the assistant response becomes inert visible text.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";
import type { TurnState } from "@/lib/assistant/chatReducer.js";
import { ToolActivityIndicator } from "./ToolActivityIndicator.js";
import { OfferCard } from "./OfferCard.js";

export interface MessageBubbleProps {
  turn: TurnState;
  isActive: boolean;
}

export function MessageBubble({ turn, isActive }: MessageBubbleProps): React.ReactElement {
  const isStreaming = turn.status === "streaming";
  const showThinking = isStreaming && turn.assistantText === "" && turn.toolActivity.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {/* User message */}
      {turn.userContent && (
        <div className="flex justify-end">
          <div
            className="max-w-[80%] rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-3 text-white"
            role="article"
            aria-label="Your message"
          >
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
              {turn.userContent}
            </p>
          </div>
        </div>
      )}

      {/* Assistant response */}
      <div className="flex justify-start">
        <div className="max-w-[85%] flex flex-col gap-2">
          {/* Thinking indicator — shown before first delta */}
          {showThinking && (
            <div
              className="flex items-center gap-2 px-4 py-3 rounded-2xl rounded-tl-sm bg-neutral-100"
              role="status"
              aria-live="polite"
              aria-label="Assistant is thinking"
            >
              <span className="flex gap-1" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-2 w-2 rounded-full bg-neutral-400 animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </span>
              <span className="text-sm text-neutral-500">Thinking…</span>
            </div>
          )}

          {/* Tool activity */}
          {turn.toolActivity.length > 0 && (
            <div className="flex flex-col gap-1">
              {turn.toolActivity.map((activity) => (
                <ToolActivityIndicator key={activity.toolCallId} activity={activity} />
              ))}
            </div>
          )}

          {/* Assistant text — plain text only, no HTML */}
          {turn.assistantText && (
            <div
              className={cn(
                "px-4 py-3 rounded-2xl rounded-tl-sm bg-neutral-100",
                turn.status === "cancelled" && "opacity-75",
                turn.status === "refused" && "border border-amber-200 bg-amber-50",
              )}
              // aria-live only on the actively streaming bubble (AC10)
              aria-live={isActive && isStreaming ? "polite" : undefined}
              aria-atomic={isActive && isStreaming ? "false" : undefined}
              role="article"
              aria-label="Assistant message"
            >
              {/*
               * SECURITY: text content rendered as a plain text node.
               * Never use dangerouslySetInnerHTML here.
               * An XSS payload in assistant text becomes inert visible text.
               */}
              <p className="text-sm text-neutral-900 leading-relaxed whitespace-pre-wrap break-words">
                {turn.assistantText}
              </p>
              {turn.status === "cancelled" && (
                <p className="mt-1 text-xs text-neutral-400 italic">Generation cancelled</p>
              )}
              {turn.status === "refused" && (
                <p className="mt-1 text-xs text-amber-600">
                  This request could not be completed.
                </p>
              )}
            </div>
          )}

          {/* Error state */}
          {turn.status === "error" && turn.error && (
            <div
              className="px-4 py-3 rounded-2xl rounded-tl-sm border border-error-200 bg-error-50"
              role="alert"
            >
              <p className="text-sm text-error-700">
                {turn.error.message}
              </p>
              <p className="mt-1 text-xs text-error-500">
                Reference: <span className="font-mono">{turn.error.reference}</span>
              </p>
            </div>
          )}

          {/* Offer cards — strictly from structured payload */}
          {turn.offerCards.length > 0 && (
            <div className="flex flex-col gap-2 mt-1" aria-label="Available offers">
              {turn.offerCards.map((card) => (
                <OfferCard key={card.offerId} card={card} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
