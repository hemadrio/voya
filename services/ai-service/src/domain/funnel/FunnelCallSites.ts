/**
 * Funnel emission call sites for the AI/assistant service (WO-106).
 *
 * Three events:
 *   conversation_started  — emitted when a new conversation begins
 *   shortlist_presented   — emitted when the assistant presents an offer shortlist
 *   conversation_handoff  — emitted when the assistant hands off to human agent
 */

import { buildFunnelEvent } from "@travel/contracts";
import type { FunnelPort } from "@travel/observability";

export function emitConversationStarted(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    conversationId: string;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "conversation_started",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      conversationId: opts.conversationId,
      category: "ASSISTANT",
      attributes: {},
    }),
  );
}

export function emitShortlistPresented(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    conversationId: string;
    offerCount?: number;
    category?: "FLIGHT" | "HOTEL" | "CAR" | "MULTI" | "ASSISTANT" | "UNKNOWN";
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "shortlist_presented",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      conversationId: opts.conversationId,
      category: opts.category ?? "ASSISTANT",
      attributes: opts.offerCount !== undefined ? { offerCount: opts.offerCount } : {},
    }),
  );
}

export function emitConversationHandoff(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    conversationId: string;
    reason?: string;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "conversation_handoff",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      conversationId: opts.conversationId,
      category: "ASSISTANT",
      attributes: opts.reason ? { reason: opts.reason } : {},
    }),
  );
}
