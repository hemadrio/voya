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
  where: { id?: string; userId?: string; familyId?: string; revokedAt: null };
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
  /** WO-022: SHA-256 hash of the opaque refresh token. */
  refreshTokenHash?: string;
  /** WO-022: Rotation family identifier — set to session.id at login time. */
  familyId?: string;
  /** WO-022: Absolute session expiry — copied verbatim through rotations. */
  absoluteExpiresAt?: Date;
}

/** Minimal row returned after creating a session. */
export interface CreatedSessionRow {
  id: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// WO-022: Refresh-token rotation types
// ---------------------------------------------------------------------------

/** A session row fetched for refresh validation. */
export interface SessionForRefresh {
  id: string;
  userId: string;
  familyId: string | null;
  revokedAt: Date | null;
  expiresAt: Date;
  absoluteExpiresAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Input for the atomic rotation operation. */
export interface RotateSessionInput {
  /** The session being consumed (must have revokedAt IS NULL). */
  oldSessionId: string;
  /** New JWT jti to store in the new session's token column. */
  newToken: string;
  /** SHA-256 hash of the new opaque refresh token. */
  newRefreshTokenHash: string;
  /** Idle expiry for the new session. */
  newExpiresAt: Date;
  /** Absolute expiry — copied verbatim from the old session. */
  absoluteExpiresAt: Date | null;
  /** Family the rotation chain belongs to. */
  familyId: string | null;
  /** User who owns the session. */
  userId: string;
  /** Client IP for the new session row. */
  ipAddress?: string;
  /** User-Agent for the new session row. */
  userAgent?: string;
}

/** Result of a successful rotation. */
export interface RotatedSessionRow {
  newSessionId: string;
  userId: string;
  familyId: string | null;
  absoluteExpiresAt: Date | null;
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
        ipAddress?: string | null;
        userAgent?: string | null;
        refreshTokenHash?: string | null;
        familyId?: string | null;
        absoluteExpiresAt?: Date | null;
        rotatedFromSessionId?: string | null;
      };
      select: { id: true; token: true; expiresAt: true; createdAt: true };
    }): Promise<CreatedSessionRow>;
    findFirst(args: {
      where: { refreshTokenHash: string };
      select: {
        id: true;
        userId: true;
        familyId: true;
        revokedAt: true;
        expiresAt: true;
        absoluteExpiresAt: true;
        ipAddress: true;
        userAgent: true;
      };
    }): Promise<SessionForRefresh | null>;
    update(args: {
      where: { id: string; revokedAt?: null };
      data: { revokedAt: Date };
    }): Promise<{ id: string }>;
    deleteMany(args: {
      where: {
        OR: Array<{
          expiresAt?: { lt: Date };
          AND?: Array<{ revokedAt?: { lt: Date; not: null } }>;
        }>;
      };
      take?: number;
    }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: SessionDbClient) => Promise<T>): Promise<T>;
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

  // WO-022 additions ─────────────────────────────────────────────────────────

  /**
   * Find a session by its refresh token hash (active or already revoked).
   * Used for both normal refresh lookup and reuse detection.
   * Returns null if no session has the given hash.
   */
  findByRefreshHash(hash: string): Promise<SessionForRefresh | null>;

  /**
   * Atomic rotation: revoke the old session and create the new one in a
   * single database transaction.
   *
   * The conditional update uses WHERE id = oldSessionId AND revokedAt IS NULL
   * so two concurrent refreshes with the same token produce exactly one winner
   * (the loser receives null and must return 401 without revoking the family).
   *
   * Returns the new session row, or null if the old session was already revoked
   * by a concurrent request (the caller must treat null as 401, not family revocation).
   */
  rotate(input: RotateSessionInput): Promise<RotatedSessionRow | null>;

  /**
   * Revoke all sessions in the given family.
   * Used when a reuse event is detected to contain the blast radius.
   * Returns the number of sessions revoked.
   */
  revokeFamily(familyId: string): Promise<number>;

  /**
   * Delete expired and old-revoked sessions in a bounded batch.
   * Expired: expiresAt < now.
   * Old-revoked: revokedAt < (now - retentionWindowMs).
   * Returns the number of rows deleted.
   */
  deleteExpired(opts: { retentionWindowMs: number; batchSize: number }): Promise<number>;
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

const SESSION_REFRESH_SELECT = {
  id: true as const,
  userId: true as const,
  familyId: true as const,
  revokedAt: true as const,
  expiresAt: true as const,
  absoluteExpiresAt: true as const,
  ipAddress: true as const,
  userAgent: true as const,
};

export function createSessionRepository(db: SessionDbClient): SessionRepository {
  return {
    async createSession(input: SessionCreateInput): Promise<CreatedSessionRow> {
      return db.session.create({
        data: {
          userId: input.userId,
          token: input.token,
          expiresAt: input.expiresAt,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          refreshTokenHash: input.refreshTokenHash ?? null,
          familyId: input.familyId ?? null,
          absoluteExpiresAt: input.absoluteExpiresAt ?? null,
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

    // WO-022 methods ──────────────────────────────────────────────────────────

    async findByRefreshHash(hash: string): Promise<SessionForRefresh | null> {
      return db.session.findFirst({
        where: { refreshTokenHash: hash },
        select: SESSION_REFRESH_SELECT,
      });
    },

    async rotate(input: RotateSessionInput): Promise<RotatedSessionRow | null> {
      try {
        return await db.$transaction(async (tx) => {
          // Atomic conditional revocation: WHERE id = ? AND revokedAt IS NULL.
          // If a concurrent request already revoked this session, Prisma throws
          // P2025 (no record found), the transaction rolls back, and the caller
          // receives null → 401 without triggering family revocation.
          await tx.session.update({
            where: { id: input.oldSessionId, revokedAt: null },
            data: { revokedAt: new Date() },
          });

          const newSession = await tx.session.create({
            data: {
              userId: input.userId,
              token: input.newToken,
              expiresAt: input.newExpiresAt,
              refreshTokenHash: input.newRefreshTokenHash,
              familyId: input.familyId,
              absoluteExpiresAt: input.absoluteExpiresAt,
              ipAddress: input.ipAddress ?? null,
              userAgent: input.userAgent ?? null,
              rotatedFromSessionId: input.oldSessionId,
            },
            select: SESSION_CREATE_SELECT,
          });

          return {
            newSessionId: newSession.id,
            userId: input.userId,
            familyId: input.familyId,
            absoluteExpiresAt: input.absoluteExpiresAt,
          };
        });
      } catch (err: unknown) {
        // Prisma P2025 = record not found (lost race on revokedAt IS NULL).
        const code = (err as { code?: string })?.code;
        if (code === "P2025") return null;
        throw err;
      }
    },

    async revokeFamily(familyId: string): Promise<number> {
      const result = await db.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count;
    },

    async deleteExpired({ retentionWindowMs, batchSize }): Promise<number> {
      const now = new Date();
      const retentionCutoff = new Date(now.getTime() - retentionWindowMs);

      const result = await db.session.deleteMany({
        where: {
          OR: [
            // Expired sessions (idle timeout passed)
            { expiresAt: { lt: now } },
            // Old-revoked sessions past the retention window
            {
              AND: [
                { revokedAt: { lt: retentionCutoff, not: null } },
              ],
            },
          ],
        },
        take: batchSize,
      });
      return result.count;
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
