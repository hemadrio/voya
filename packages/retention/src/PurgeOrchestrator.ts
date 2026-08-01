/**
 * PurgeOrchestrator — coordinates per-category retention enforcement.
 *
 * Design:
 *   - Injected RegisterProvider, RetentionConfig, Clock, Repository, strategies, metrics, logger
 *   - Never fails open: category failure aborts that category, increments failure
 *     metric, and contributes to a non-zero exit code
 *   - Dry-run is the default; --apply flag must be explicit
 *   - Guard: refuses to dispatch a delete strategy for erasure_excluded entries
 *   - Load-aware: skips or defers batches when DB load exceeds threshold
 *   - Run lease: prevents concurrent overlapping runs
 *   - Structured logs: actor, resource, operation, counts only — no PII (BR-13)
 */

import type { ClassificationRegister } from "@travel/contracts/retention";
import type {
  PurgeClock,
  PurgeRepositoryPort,
  PurgeMetrics,
  PurgeLogger,
  CategoryPurgeStrategy,
  StrategyResult,
  PurgeRunRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Orchestrator configuration
// ---------------------------------------------------------------------------

export interface PurgeOrchestratorConfig {
  /** Batch size for each category sweep. Default: 500. */
  batchSize: number;
  /** Milliseconds to wait between batches. Default: 250. */
  interBatchPauseMs: number;
  /** Maximum batches per category per run (prevents runaway). Default: 1000. */
  maxBatchesPerCategory: number;
  /** DB load factor above which batches are deferred. Default: 0.7 (70%). */
  loadThreshold: number;
  /** TTL in seconds for the run lease. Default: 3600. */
  leaseTtlSeconds: number;
}

const DEFAULT_CONFIG: PurgeOrchestratorConfig = {
  batchSize: 500,
  interBatchPauseMs: 250,
  maxBatchesPerCategory: 1000,
  loadThreshold: 0.7,
  leaseTtlSeconds: 3600,
};

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export type CategoryStatus = "success" | "partial" | "skipped" | "failure" | "excluded";

export interface CategoryRunResult {
  entryId: string;
  category: string;
  table: string;
  status: CategoryStatus;
  examined: number;
  purged: number;
  keysDestroyed: number;
  skippedLegalHold: number;
  durationMs: number;
  errorMessage?: string;
}

export interface OrchestratorRunResult {
  correlationId: string;
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  categories: CategoryRunResult[];
  /** True when any category failed — signals non-zero exit. */
  hasFailures: boolean;
}

// ---------------------------------------------------------------------------
// PurgeOrchestrator
// ---------------------------------------------------------------------------

export class PurgeOrchestrator {
  private readonly config: PurgeOrchestratorConfig;

  constructor(
    private readonly register: ClassificationRegister,
    private readonly strategies: Map<string, CategoryPurgeStrategy>,
    private readonly repo: PurgeRepositoryPort,
    private readonly clock: PurgeClock,
    private readonly metrics: PurgeMetrics,
    private readonly logger: PurgeLogger,
    config?: Partial<PurgeOrchestratorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async run(
    options: { dryRun: boolean; correlationId: string },
  ): Promise<OrchestratorRunResult> {
    const { dryRun, correlationId } = options;
    const startedAt = this.clock.now();

    this.metrics.recordRunStart();
    this.logger.info(
      { correlationId, dryRun, entryCount: this.register.entries.length },
      "purge.orchestrator: run started",
    );

    // Acquire global run lease (prevents concurrent overlapping runs)
    const leaseKey = "purge:global";
    const leaseAcquired = await this.repo.acquireLease(leaseKey, this.config.leaseTtlSeconds);
    if (!leaseAcquired) {
      this.logger.warn(
        { correlationId },
        "purge.orchestrator: another run is in progress — skipping",
      );
      return this.buildResult(correlationId, dryRun, startedAt, [], false);
    }

    const categoryResults: CategoryRunResult[] = [];
    let hasFailures = false;

    try {
      for (const entry of this.register.entries) {
        const categoryStart = this.clock.now();

        // Guard: refuse delete strategies for erasure_excluded entries
        if (entry.erasureExcluded && entry.erasureMethod !== "none" && entry.erasureMethod !== "pseudonymisation") {
          this.logger.error(
            { correlationId, entryId: entry.id, category: entry.category, erasureMethod: entry.erasureMethod },
            "purge.orchestrator: GUARD VIOLATION — erasure_excluded entry has delete-capable erasure method",
          );
          categoryResults.push({
            entryId: entry.id,
            category: entry.category,
            table: entry.table,
            status: "failure",
            examined: 0,
            purged: 0,
            keysDestroyed: 0,
            durationMs: 0,
            errorMessage: "erasure_excluded entry must not have a delete strategy",
          });
          this.metrics.recordFailure(entry.category);
          hasFailures = true;
          continue;
        }

        // Entries marked erasureExcluded with erasureMethod=none → skip erasure
        if (entry.erasureExcluded && entry.erasureMethod === "none") {
          this.logger.info(
            { correlationId, entryId: entry.id, category: entry.category },
            "purge.orchestrator: audit entry excluded from erasure sweep",
          );
          categoryResults.push({
            entryId: entry.id,
            category: entry.category,
            table: entry.table,
            status: "excluded",
            examined: 0,
            purged: 0,
            keysDestroyed: 0,
            skippedLegalHold: 0,
            durationMs: 0,
          });
          continue;
        }

        // Load guard: defer this category if DB is under high load
        const loadFactor = await this.repo.getDbLoadFactor();
        if (loadFactor > this.config.loadThreshold) {
          this.logger.warn(
            { correlationId, entryId: entry.id, category: entry.category, loadFactor },
            "purge.orchestrator: DB load above threshold — deferring category",
          );
          categoryResults.push({
            entryId: entry.id,
            category: entry.category,
            table: entry.table,
            status: "skipped",
            examined: 0,
            purged: 0,
            keysDestroyed: 0,
            skippedLegalHold: 0,
            durationMs: 0,
          });
          continue;
        }

        // Resolve strategy
        const strategy = this.strategies.get(entry.erasureMethod);
        if (!strategy) {
          const msg = `No strategy registered for erasure method: ${entry.erasureMethod}`;
          this.logger.error(
            { correlationId, entryId: entry.id, category: entry.category, erasureMethod: entry.erasureMethod },
            `purge.orchestrator: ${msg}`,
          );
          this.metrics.recordFailure(entry.category);
          hasFailures = true;
          categoryResults.push({
            entryId: entry.id,
            category: entry.category,
            table: entry.table,
            status: "failure",
            examined: 0,
            purged: 0,
            keysDestroyed: 0,
            skippedLegalHold: 0,
            durationMs: 0,
            errorMessage: msg,
          });
          continue;
        }

        // Execute strategy
        let result: StrategyResult;
        let errorMessage: string | undefined;

        try {
          result = await strategy.execute(entry, {
            now: this.clock.now(),
            batchSize: this.config.batchSize,
            interBatchPauseMs: this.config.interBatchPauseMs,
            dryRun,
            correlationId,
            maxBatches: this.config.maxBatchesPerCategory,
          });
        } catch (err) {
          // Never fail open (policy A10) — record failure and continue to next category
          // Never log error message or stack (BR-13 — no provider payloads)
          errorMessage = "strategy execution failed";
          this.logger.error(
            { correlationId, entryId: entry.id, category: entry.category },
            "purge.orchestrator: category strategy threw — category aborted",
          );
          this.metrics.recordFailure(entry.category);
          hasFailures = true;

          const durationMs = this.clock.now().getTime() - categoryStart.getTime();
          categoryResults.push({
            entryId: entry.id,
            category: entry.category,
            table: entry.table,
            status: "failure",
            examined: 0,
            purged: 0,
            keysDestroyed: 0,
            skippedLegalHold: 0,
            durationMs,
            errorMessage,
          });
          this.metrics.recordDuration(entry.category, durationMs);
          continue;
        }

        const durationMs = this.clock.now().getTime() - categoryStart.getTime();
        const categoryStatus: CategoryStatus = result.status === "partial" ? "partial" : result.status;

        this.metrics.recordExamined(entry.category, result.examined);
        this.metrics.recordPurged(entry.category, result.purged);
        if (result.keysDestroyed > 0) {
          this.metrics.recordKeysDestroyed(entry.category, result.keysDestroyed);
        }
        if (result.skippedLegalHold > 0) {
          this.metrics.recordSkippedLegalHold(entry.category, result.skippedLegalHold);
        }
        this.metrics.recordDuration(entry.category, durationMs);

        this.logger.info(
          {
            correlationId,
            entryId: entry.id,
            category: entry.category,
            table: entry.table,
            examined: result.examined,
            purged: result.purged,
            keysDestroyed: result.keysDestroyed,
            skippedLegalHold: result.skippedLegalHold,
            durationMs,
            dryRun,
          },
          "purge.orchestrator: category complete",
        );

        // Immutable audit record for every purge action
        // Counts only — no subject identifiers or PII (BR-13)
        if (!dryRun && (result.purged > 0 || result.skippedLegalHold > 0)) {
          const purgeRun: PurgeRunRecord = {
            category: entry.category,
            entryId: entry.id,
            startedAt: categoryStart,
            finishedAt: this.clock.now(),
            examined: result.examined,
            purged: result.purged,
            keysDestroyed: result.keysDestroyed,
            skippedLegalHold: result.skippedLegalHold,
            status: categoryStatus === "failure" ? "failure" : categoryStatus === "skipped" ? "skipped" : "success",
            correlationId,
            dryRun: false,
          };
          await this.repo.recordPurgeRun(purgeRun).catch(() => {
            // Audit write failure must not mask the purge result
            this.logger.error(
              { correlationId, entryId: entry.id },
              "purge.orchestrator: failed to write audit record",
            );
          });
        }

        categoryResults.push({
          entryId: entry.id,
          category: entry.category,
          table: entry.table,
          status: categoryStatus,
          examined: result.examined,
          purged: result.purged,
          keysDestroyed: result.keysDestroyed,
          skippedLegalHold: result.skippedLegalHold,
          durationMs,
        });
      }
    } finally {
      await this.repo.releaseLease(leaseKey).catch(() => {
        this.logger.warn({ correlationId }, "purge.orchestrator: failed to release run lease");
      });
    }

    this.metrics.recordRunComplete(dryRun);

    return this.buildResult(correlationId, dryRun, startedAt, categoryResults, hasFailures);
  }

  private buildResult(
    correlationId: string,
    dryRun: boolean,
    startedAt: Date,
    categories: CategoryRunResult[],
    hasFailures: boolean,
  ): OrchestratorRunResult {
    return {
      correlationId,
      dryRun,
      startedAt,
      finishedAt: this.clock.now(),
      categories,
      hasFailures,
    };
  }
}
