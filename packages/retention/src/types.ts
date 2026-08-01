/**
 * Shared types for the purge orchestrator and its strategies.
 * All dependencies are injected — no database or AWS imports here.
 */

import type { RegisterEntry } from "@travel/contracts/retention";

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface PurgeClock {
  now(): Date;
}

export class SystemPurgeClock implements PurgeClock {
  now(): Date {
    return new Date();
  }
}

// ---------------------------------------------------------------------------
// Repository port — parameterized queries only (policy A05)
// ---------------------------------------------------------------------------

export interface PurgeRepositoryPort {
  /**
   * Count rows eligible for purge (purge_after <= now).
   * Used for dry-run reporting without mutation.
   */
  countExpired(table: string, now: Date): Promise<number>;

  /**
   * Delete up to batchSize rows where purge_after <= now.
   * Returns the number of rows actually deleted.
   * Must use parameterized queries only — no string interpolation.
   */
  deleteBatch(table: string, batchSize: number, now: Date): Promise<number>;

  /**
   * For crypto-erasure: fetch rows eligible for purge with their subject IDs
   * and wrapped DEK metadata.
   */
  fetchErasureCandidates(
    table: string,
    batchSize: number,
    now: Date,
  ): Promise<ErasureCandidate[]>;

  /**
   * After DEK destruction, null out the wrapped_dek column and clear PII columns.
   * Returns count of rows updated.
   */
  nullifyWrappedDek(table: string, ids: string[]): Promise<number>;

  /**
   * Pseudonymise actor references in audit rows for a subject.
   * Replaces actor_id with SHA-256('REDACTED:' || actor_id).
   * Returns count of rows updated.
   */
  pseudonymiseActor(table: string, actorIds: string[]): Promise<number>;

  /**
   * Conversation sweep: delete Redis keys older than cutoff.
   * Returns count of keys deleted.
   */
  deleteConversationKeys(cutoffDate: Date, batchSize: number): Promise<number>;

  /**
   * Record a purge run in the purge_runs table (audit trail).
   */
  recordPurgeRun(run: PurgeRunRecord): Promise<void>;

  /**
   * Acquire an exclusive run lease. Returns false if already held.
   * leaseKey is typically `purge:${category}`.
   */
  acquireLease(leaseKey: string, ttlSeconds: number): Promise<boolean>;

  /**
   * Release a run lease.
   */
  releaseLease(leaseKey: string): Promise<void>;

  /**
   * Load guard: returns a value in [0, 1] representing current DB load.
   * The implementation may return the ratio of active connections to max_connections.
   * Returns 0 when unable to determine load (fail-open for the guard).
   */
  getDbLoadFactor(): Promise<number>;

  /**
   * Quarantine a row that could not be purged.
   */
  quarantine(entry: QuarantineEntry): Promise<void>;

  /**
   * Count rows with purge_after due but skipped due to legal_hold=true.
   * Used for dry-run and live-run metric reporting.
   */
  countLegalHold(table: string, now: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// Candidate types
// ---------------------------------------------------------------------------

export interface ErasureCandidate {
  id: string;
  subjectId: string;
  wrappedDek: Buffer | null;
  dekKeyId: string | null;
  bookingId: string;
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export interface PurgeRunRecord {
  category: string;
  entryId: string;
  startedAt: Date;
  finishedAt: Date;
  examined: number;
  purged: number;
  keysDestroyed: number;
  /** Rows skipped due to legal_hold=true. Counts only — no identifiers (BR-13). */
  skippedLegalHold: number;
  status: "success" | "failure" | "dry_run" | "skipped";
  errorMessage?: string;
  correlationId: string;
  dryRun: boolean;
}

export interface QuarantineEntry {
  table: string;
  rowId: string;
  reason: string;
  correlationId: string;
  quarantinedAt: Date;
}

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

export interface CategoryPurgeStrategy {
  readonly name: string;

  execute(
    entry: RegisterEntry,
    options: StrategyExecuteOptions,
  ): Promise<StrategyResult>;
}

export interface StrategyExecuteOptions {
  now: Date;
  batchSize: number;
  interBatchPauseMs: number;
  dryRun: boolean;
  correlationId: string;
  maxBatches: number;
}

export interface StrategyResult {
  examined: number;
  purged: number;
  keysDestroyed: number;
  /** Rows skipped because legal_hold=true at purge time. */
  skippedLegalHold: number;
  status: "success" | "partial" | "skipped";
}

// ---------------------------------------------------------------------------
// Purge metrics interface (injectable)
// ---------------------------------------------------------------------------

export interface PurgeMetrics {
  recordExamined(category: string, count: number): void;
  recordPurged(category: string, count: number): void;
  recordKeysDestroyed(category: string, count: number): void;
  /** Rows skipped due to legal_hold=true. */
  recordSkippedLegalHold(category: string, count: number): void;
  recordFailure(category: string): void;
  recordDuration(category: string, durationMs: number): void;
  recordRunStart(): void;
  recordRunComplete(dryRun: boolean): void;
}

// ---------------------------------------------------------------------------
// Logger interface (injectable, no pino dependency)
// ---------------------------------------------------------------------------

export interface PurgeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}
