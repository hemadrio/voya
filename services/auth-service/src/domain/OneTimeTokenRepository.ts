/**
 * OneTimeTokenRepository — duck-typed interface for one-time token persistence.
 *
 * Tokens are stored only as SHA-256 hashes; the raw value is never persisted.
 * Single-use enforcement is guaranteed by the atomic consumed_at update.
 */

// ---------------------------------------------------------------------------
// Minimal Prisma-compatible client slice
// ---------------------------------------------------------------------------

interface TokenCreateData {
  userId: string;
  purpose: string;
  tokenHash: string;
  expiresAt: Date;
}

interface TokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface TokenDbClient {
  oneTimeToken: {
    create(args: { data: TokenCreateData }): Promise<{ id: string }>;
    findFirst(args: {
      where: { tokenHash: string; purpose: string };
      select: {
        id: boolean;
        userId: boolean;
        expiresAt: boolean;
        consumedAt: boolean;
      };
    }): Promise<TokenRecord | null>;
    updateMany(args: {
      where: { id?: string; userId?: string; purpose?: string; consumedAt: null };
      data: { consumedAt: Date };
    }): Promise<{ count: number }>;
  };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface OneTimeTokenRepository {
  /** Persist a new hashed token. Returns the generated record ID. */
  create(params: {
    userId: string;
    purpose: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<string>;

  /**
   * Look up a token record by hash and purpose.
   * Returns null when not found.
   */
  findByHash(
    tokenHash: string,
    purpose: string,
  ): Promise<TokenRecord | null>;

  /**
   * Atomically mark a specific token as consumed.
   * Returns true if it was successfully consumed (was not already consumed).
   */
  consume(tokenId: string): Promise<boolean>;

  /**
   * Invalidate all outstanding (unconsumed) tokens for a user and purpose.
   * Returns the number of tokens invalidated.
   */
  invalidateAllForUser(userId: string, purpose: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Concrete implementation
// ---------------------------------------------------------------------------

export function createOneTimeTokenRepository(db: TokenDbClient): OneTimeTokenRepository {
  return {
    async create({ userId, purpose, tokenHash, expiresAt }) {
      const record = await db.oneTimeToken.create({
        data: { userId, purpose, tokenHash, expiresAt },
      });
      return record.id;
    },

    async findByHash(tokenHash, purpose) {
      return db.oneTimeToken.findFirst({
        where: { tokenHash, purpose },
        select: { id: true, userId: true, expiresAt: true, consumedAt: true },
      });
    },

    async consume(tokenId) {
      const result = await db.oneTimeToken.updateMany({
        where: { id: tokenId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return result.count > 0;
    },

    async invalidateAllForUser(userId, purpose) {
      const result = await db.oneTimeToken.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return result.count;
    },
  };
}
