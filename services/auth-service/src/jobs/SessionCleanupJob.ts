/**
 * SessionCleanupJob — background job that prunes expired and old-revoked
 * session rows so the sessions table stays small.
 *
 * Two categories of rows are deleted per run:
 *   1. Idle-expired: sessions whose `expiresAt` is in the past.
 *   2. Old-revoked: sessions that were revoked more than `retentionWindowMs`
 *      ago (kept for the window so reuse detection can fire on stolen tokens
 *      presented after logout; after the window the row is no longer useful).
 *
 * The job is idempotent and batched: it deletes at most `batchSize` rows per
 * invocation so a single large purge does not produce lock contention.
 * Re-schedule with a smaller interval to drain a large backlog.
 *
 * Hexagonal architecture: no Express or PrismaClient imports.  All I/O is
 * injected via the SessionRepository interface.
 */

import type { SessionRepository } from "../domain/SessionRepository.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SessionCleanupConfig {
  /**
   * How long to retain revoked session rows for reuse detection after they
   * are revoked (milliseconds).  Default: 30 days.
   */
  retentionWindowMs?: number;
  /**
   * Maximum number of rows deleted per invocation.
   * Default: 1000.
   */
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// Metrics emitted per run
// ---------------------------------------------------------------------------

export interface CleanupRunMetrics {
  /** Number of rows deleted in this run. */
  deletedCount: number;
  /** Wall-clock duration of the delete query (milliseconds). */
  durationMs: number;
  /** Whether the batch was at capacity (true → more rows may remain). */
  batchFull: boolean;
}

// ---------------------------------------------------------------------------
// Logger interface (thin subset to avoid coupling to a specific logger)
// ---------------------------------------------------------------------------

export interface CleanupLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ISessionCleanupJob {
  /**
   * Run one cleanup pass.  Returns metrics for the caller to log / emit to
   * a metrics sink.  Never throws on database errors — logs and returns a
   * zero-count result instead so a transient DB failure does not crash the
   * scheduler.
   */
  run(): Promise<CleanupRunMetrics>;
}

export function createSessionCleanupJob(
  sessionRepository: SessionRepository,
  config: SessionCleanupConfig = {},
  logger?: CleanupLogger,
): ISessionCleanupJob {
  const retentionWindowMs = config.retentionWindowMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
  const batchSize = config.batchSize ?? 1000;

  async function run(): Promise<CleanupRunMetrics> {
    const start = performance.now();
    let deletedCount = 0;

    try {
      deletedCount = await sessionRepository.deleteExpired({ retentionWindowMs, batchSize });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error("SessionCleanupJob: deleteExpired failed", { error: message });
      return { deletedCount: 0, durationMs: performance.now() - start, batchFull: false };
    }

    const durationMs = performance.now() - start;
    const batchFull = deletedCount >= batchSize;

    logger?.info("SessionCleanupJob: completed", { deletedCount, durationMs, batchFull });

    return { deletedCount, durationMs, batchFull };
  }

  return { run };
}
