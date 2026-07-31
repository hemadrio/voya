/**
 * IdentitySessionRepository — typed data-access for session lifecycle operations.
 *
 * Handles create, refresh-hash lookup, and revocation.
 * The existing SessionRepository handles listing and bulk revocation;
 * this module covers the identity-schema operations introduced in WO-018.
 *
 * SECURITY INVARIANT:
 *   refresh_token_hash stores only a hash of the refresh token.
 *   The raw token is never written here and must not appear in logs or responses.
 *
 * Hexagonal architecture: depends only on injected interfaces.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Safe session view — excludes raw tokens, only token hashes. */
export interface SessionEntity {
  id: string;
  userId: string;
  refreshTokenHash: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedFromSessionId: string | null;
}

export interface CreateSessionInput {
  userId: string;
  /** Hash of the refresh token (never the raw token). */
  refreshTokenHash: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  expiresAt: Date;
  rotatedFromSessionId?: string | null;
}

// ---------------------------------------------------------------------------
// DB client interface (duck-typed against Prisma)
// ---------------------------------------------------------------------------

type SessionSafeSelect = {
  id: true;
  userId: true;
  refreshTokenHash: true;
  userAgent: true;
  ipAddress: true;
  createdAt: true;
  expiresAt: true;
  revokedAt: true;
  rotatedFromSessionId: true;
};

type SessionRow = {
  id: string;
  userId: string;
  refreshTokenHash: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedFromSessionId: string | null;
};

interface SessionCreateArgs {
  data: {
    userId: string;
    refreshTokenHash: string;
    userAgent?: string | null;
    ipAddress?: string | null;
    expiresAt: Date;
    rotatedFromSessionId?: string | null;
    token: string;
  };
  select: SessionSafeSelect;
}

interface SessionFindArgs {
  where: { refreshTokenHash: string; revokedAt: null; expiresAt: { gt: Date } };
  select: SessionSafeSelect;
}

interface SessionUpdateArgs {
  where: { id: string };
  data: { revokedAt: Date };
}

export interface IdentitySessionDbClient {
  session: {
    create(args: SessionCreateArgs): Promise<SessionRow>;
    findFirst(args: SessionFindArgs): Promise<SessionRow | null>;
    update(args: SessionUpdateArgs): Promise<SessionRow>;
  };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface IdentitySessionRepository {
  /** Create a new session row. refreshTokenHash must be a hash, not the raw token. */
  create(input: CreateSessionInput): Promise<SessionEntity>;

  /**
   * Find an active (non-revoked, non-expired) session by its refresh token hash.
   * Returns null if no match, already revoked, or already expired.
   */
  findActiveByRefreshHash(refreshTokenHash: string): Promise<SessionEntity | null>;

  /**
   * Revoke a session by ID.
   * Sets revokedAt to now. Idempotent — calling on an already-revoked session
   * is a no-op at the DB level (the update just overwrites revokedAt).
   */
  revoke(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SESSION_SAFE_SELECT: SessionSafeSelect = {
  id: true,
  userId: true,
  refreshTokenHash: true,
  userAgent: true,
  ipAddress: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  rotatedFromSessionId: true,
};

function rowToEntity(row: SessionRow): SessionEntity {
  return {
    id: row.id,
    userId: row.userId,
    refreshTokenHash: row.refreshTokenHash,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    issuedAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    rotatedFromSessionId: row.rotatedFromSessionId,
  };
}

export function createIdentitySessionRepository(db: IdentitySessionDbClient): IdentitySessionRepository {
  return {
    async create(input: CreateSessionInput): Promise<SessionEntity> {
      const row = await db.session.create({
        data: {
          userId: input.userId,
          refreshTokenHash: input.refreshTokenHash,
          userAgent: input.userAgent ?? null,
          ipAddress: input.ipAddress ?? null,
          expiresAt: input.expiresAt,
          rotatedFromSessionId: input.rotatedFromSessionId ?? null,
          // token is a legacy NOT NULL column on the sessions table; provide
          // a placeholder value so existing rows remain valid.
          token: `__placeholder_${crypto.randomUUID()}`,
        },
        select: SESSION_SAFE_SELECT,
      });
      return rowToEntity(row);
    },

    async findActiveByRefreshHash(refreshTokenHash: string): Promise<SessionEntity | null> {
      const row = await db.session.findFirst({
        where: {
          refreshTokenHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: SESSION_SAFE_SELECT,
      });
      return row ? rowToEntity(row) : null;
    },

    async revoke(sessionId: string): Promise<void> {
      await db.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      });
    },
  };
}
