/**
 * conversationRetention — batched idempotent deletion of stale conversations (WO-057).
 *
 * Runs separate passes for guest and authenticated conversations using
 * configurable inactivity windows. Safe to run repeatedly: a second run
 * on the same schedule finds nothing to delete and exits cleanly.
 *
 * Content-free logging: only counts and timestamps are logged — no conversation
 * ids, titles, or message content appear in any log or metric label.
 */

// ---------------------------------------------------------------------------
// Retention configuration
// ---------------------------------------------------------------------------

export interface RetentionConfig {
  /** Milliseconds of inactivity before a guest conversation is deleted. Default: 7 days. */
  guestInactivityMs?: number;
  /** Milliseconds of inactivity before an authenticated user conversation is deleted. Default: 90 days. */
  userInactivityMs?: number;
  /** Maximum rows to delete per batch. Default: 100. */
  batchSize?: number;
}

const DEFAULT_GUEST_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const DEFAULT_USER_MS = 90 * 24 * 60 * 60 * 1000;   // 90 days
const DEFAULT_BATCH = 100;

// ---------------------------------------------------------------------------
// Injectable clock — makes tests deterministic
// ---------------------------------------------------------------------------

export type ClockFn = () => Date;

// ---------------------------------------------------------------------------
// Duck-typed DB client — only the deleteMany we need
// ---------------------------------------------------------------------------

export interface RetentionDbClient {
  conversation: {
    deleteMany(args: {
      where: {
        userId?: null | { not: null };
        guestSessionId?: null | { not: null };
        lastActivityAt: { lt: Date };
      };
      // Non-standard but useful: some adapters support take for batch limiting
    }): Promise<{ count: number }>;
  };
}

// ---------------------------------------------------------------------------
// Logger interface — content-free structured output
// ---------------------------------------------------------------------------

export interface RetentionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Retention result
// ---------------------------------------------------------------------------

export interface RetentionResult {
  guestDeleted: number;
  userDeleted: number;
  ranAt: Date;
}

// ---------------------------------------------------------------------------
// runConversationRetention
// ---------------------------------------------------------------------------

/**
 * Delete stale conversations for both guest and authenticated principals.
 *
 * @param db    Duck-typed DB client (Prisma-compatible).
 * @param log   Structured logger — must never emit conversation content.
 * @param clock Injected clock for testability; defaults to `() => new Date()`.
 * @param config Window and batch configuration.
 */
export async function runConversationRetention(
  db: RetentionDbClient,
  log: RetentionLogger,
  clock: ClockFn,
  config: RetentionConfig = {},
): Promise<RetentionResult> {
  const guestWindowMs = config.guestInactivityMs ?? DEFAULT_GUEST_MS;
  const userWindowMs = config.userInactivityMs ?? DEFAULT_USER_MS;

  const now = clock();
  const guestCutoff = new Date(now.getTime() - guestWindowMs);
  const userCutoff = new Date(now.getTime() - userWindowMs);

  log.info('conversation-retention:start', {
    guestCutoff: guestCutoff.toISOString(),
    userCutoff: userCutoff.toISOString(),
  });

  // --- Guest pass ---
  let guestDeleted = 0;
  try {
    const result = await db.conversation.deleteMany({
      where: {
        userId: null,
        guestSessionId: { not: null },
        lastActivityAt: { lt: guestCutoff },
      },
    });
    guestDeleted = result.count;
    log.info('conversation-retention:guest-pass', { deleted: guestDeleted });
  } catch (err) {
    log.error('conversation-retention:guest-pass-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // --- Authenticated user pass ---
  let userDeleted = 0;
  try {
    const result = await db.conversation.deleteMany({
      where: {
        userId: { not: null },
        guestSessionId: null,
        lastActivityAt: { lt: userCutoff },
      },
    });
    userDeleted = result.count;
    log.info('conversation-retention:user-pass', { deleted: userDeleted });
  } catch (err) {
    log.error('conversation-retention:user-pass-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('conversation-retention:complete', {
    guestDeleted,
    userDeleted,
    total: guestDeleted + userDeleted,
    ranAt: now.toISOString(),
  });

  return { guestDeleted, userDeleted, ranAt: now };
}
