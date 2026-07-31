/**
 * SessionService — coordinates session revocation and listing.
 *
 * Centralises all session state changes so every revocation path (logout,
 * logout-all, session delete, password reset) calls the same invalidation
 * hook and emits audit log entries through the same code path.
 *
 * Cache invalidation note: revocation is immediate on the node processing the
 * request. On other nodes, revoked sessions remain valid until the access
 * token's exp is reached (typically 15 minutes). A shared cache or pub/sub
 * subscription would provide bounded multi-node invalidation as a future
 * improvement; the sessionCache hook is the extension point for that.
 */

import { sessionNotFound } from "@travel/contracts";
import type { SessionRepository } from "./SessionRepository.js";
import type { SessionInfo } from "./types.js";
import { sessionInfoFromRow } from "./SessionRepository.js";

// ---------------------------------------------------------------------------
// Session cache invalidation hook — injectable for testing
// ---------------------------------------------------------------------------

/** Invalidation hook: called after every revocation to evict cached session state. */
export interface SessionCacheInvalidator {
  /** Invalidate a specific session entry. */
  invalidateSession(sessionId: string): Promise<void>;
  /** Invalidate all session entries for a user. */
  invalidateUser(userId: string): Promise<void>;
}

const noopInvalidator: SessionCacheInvalidator = {
  async invalidateSession(_sessionId: string) {},
  async invalidateUser(_userId: string) {},
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SessionServiceDeps {
  sessionRepository: SessionRepository;
  cacheInvalidator?: SessionCacheInvalidator;
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface SessionService {
  logout(params: { sid: string; userId: string }): Promise<void>;
  logoutAll(params: { userId: string }): Promise<{ revokedCount: number }>;
  listSessions(params: { userId: string; currentSid: string }): Promise<{ sessions: SessionInfo[] }>;
  deleteSession(params: { sessionId: string; userId: string; currentSid: string }): Promise<void>;
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const { sessionRepository, logger } = deps;
  const cache = deps.cacheInvalidator ?? noopInvalidator;

  return {
    async logout({ sid, userId }) {
      await sessionRepository.revokeById(sid, userId);
      await cache.invalidateSession(sid);
      logger?.info({ event: "auth.logout", userId, sid }, "Session revoked");
    },

    async logoutAll({ userId }) {
      const revokedCount = await sessionRepository.revokeAllForUser(userId);
      await cache.invalidateUser(userId);
      logger?.info({ event: "auth.logout_all", userId, revokedCount }, "All sessions revoked");
      return { revokedCount };
    },

    async listSessions({ userId, currentSid }) {
      const rows = await sessionRepository.listActiveForUser(userId);
      const sessions = rows.map((row) => sessionInfoFromRow(row, currentSid));
      return { sessions };
    },

    async deleteSession({ sessionId, userId, currentSid }) {
      const revoked = await sessionRepository.revokeById(sessionId, userId);
      if (!revoked) {
        throw sessionNotFound();
      }
      await cache.invalidateSession(sessionId);
      logger?.info(
        { event: "auth.session_deleted", userId, sessionId, wasCurrent: sessionId === currentSid },
        "Session deleted",
      );
    },
  };
}
