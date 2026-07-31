/**
 * SessionRepository — duck-typed interface for session persistence.
 *
 * The domain layer depends only on this interface; the concrete Prisma
 * implementation is injected at startup so unit tests can pass a plain object
 * without instantiating the real PrismaClient.
 */

import type { SessionInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal Prisma-compatible client slice
// ---------------------------------------------------------------------------

interface SessionUpdateManyArgs {
  where: { id?: string; userId: string; revokedAt: null };
  data: { revokedAt: Date };
}

interface SessionFindManyArgs {
  where: { userId: string; revokedAt: null };
  select: {
    id: boolean;
    createdAt: boolean;
    lastSeenAt: boolean;
    ipAddress: boolean;
    userAgent: boolean;
  };
  orderBy?: { createdAt: "desc" | "asc" };
}

interface ActiveSessionRow {
  id: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
}

// ---------------------------------------------------------------------------
// Session creation — used by the login pipeline (WO-021)
// ---------------------------------------------------------------------------

export interface SessionCreateInput {
  /** User who owns this session. */
  userId: string;
  /**
   * JWT ID (jti claim) stored in the legacy token column.
   * Must be unique — used to detect token reuse in WO-022.
   */
  token: string;
  /** When the access token (and therefore this session record) expires. */
  expiresAt: Date;
  /** Client IPv4/IPv6 address (up to 45 chars). */
  ipAddress?: string;
  /** User-Agent header value (truncated to 512 chars by the schema). */
  userAgent?: string;
}

/** Minimal row returned after creating a session. */
export interface CreatedSessionRow {
  id: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface SessionDbClient {
  session: {
    updateMany(args: SessionUpdateManyArgs): Promise<{ count: number }>;
    findMany(args: SessionFindManyArgs): Promise<ActiveSessionRow[]>;
    create(args: {
      data: {
        userId: string;
        token: string;
        expiresAt: Date;
        ipAddress?: string;
        userAgent?: string;
      };
      select: { id: true; token: true; expiresAt: true; createdAt: true };
    }): Promise<CreatedSessionRow>;
  };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface SessionRepository {
  /**
   * Create a new session row after a successful login.
   * The `token` field stores the JWT jti for the issued access token.
   */
  createSession(input: SessionCreateInput): Promise<CreatedSessionRow>;

  /**
   * Revoke a single session by ID, filtered to the owning user.
   * Returns true if the session was found and revoked; false if it did not
   * exist or was already revoked (idempotent).
   */
  revokeById(sessionId: string, userId: string): Promise<boolean>;

  /**
   * Revoke all active sessions for a user in a single bounded statement.
   * Returns the number of sessions revoked (0 if none were active).
   */
  revokeAllForUser(userId: string): Promise<number>;

  /**
   * List active sessions for a user.
   * Explicitly selects safe columns only — never returns refresh_token_hash.
   */
  listActiveForUser(userId: string): Promise<ActiveSessionRow[]>;
}

// ---------------------------------------------------------------------------
// Concrete implementation backed by a duck-typed Prisma client
// ---------------------------------------------------------------------------

const SESSION_CREATE_SELECT = {
  id: true as const,
  token: true as const,
  expiresAt: true as const,
  createdAt: true as const,
};

export function createSessionRepository(db: SessionDbClient): SessionRepository {
  return {
    async createSession(input: SessionCreateInput): Promise<CreatedSessionRow> {
      return db.session.create({
        data: {
          userId: input.userId,
          token: input.token,
          expiresAt: input.expiresAt,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
        select: SESSION_CREATE_SELECT,
      });
    },

    async revokeById(sessionId: string, userId: string): Promise<boolean> {
      const result = await db.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count > 0;
    },

    async revokeAllForUser(userId: string): Promise<number> {
      const result = await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count;
    },

    async listActiveForUser(userId: string): Promise<ActiveSessionRow[]> {
      return db.session.findMany({
        where: { userId, revokedAt: null },
        select: {
          id: true,
          createdAt: true,
          lastSeenAt: true,
          ipAddress: true,
          userAgent: true,
        },
        orderBy: { createdAt: "desc" },
      });
    },
  };
}

export function sessionInfoFromRow(row: ActiveSessionRow, currentSid: string): SessionInfo {
  return {
    id: row.id,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    current: row.id === currentSid,
  };
}
