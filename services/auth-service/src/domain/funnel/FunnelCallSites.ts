/**
 * Funnel emission call sites for the auth service (WO-106).
 *
 * Two events:
 *   session_started   — emitted on successful login or anonymous session init
 *   guest_registered  — emitted when a guest session converts to a registered account
 */

import { buildFunnelEvent } from "@travel/contracts";
import type { FunnelPort } from "@travel/observability";

export function emitSessionStarted(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
    isAnonymous?: boolean;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "session_started",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      category: "AUTH",
      attributes: { isAnonymous: opts.isAnonymous ?? false },
    }),
  );
}

export function emitGuestRegistered(
  port: FunnelPort,
  opts: {
    correlationId: string;
    pseudonymousActorId: string;
    sessionId: string;
  },
): void {
  port.emit(
    buildFunnelEvent({
      eventType: "guest_registered",
      occurredAt: new Date().toISOString(),
      correlationId: opts.correlationId,
      pseudonymousActorId: opts.pseudonymousActorId,
      sessionId: opts.sessionId,
      category: "AUTH",
      attributes: {},
    }),
  );
}
