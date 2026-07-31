/**
 * PhysicalDeleteStrategy — batched DELETE for scalar personal data.
 *
 * Uses parameterized queries only (policy A05).
 * Respects batch size and inter-batch pause so purge cannot saturate the DB
 * or breach the search/checkout latency budgets.
 */

import type { CategoryPurgeStrategy, PurgeRepositoryPort, PurgeLogger, StrategyExecuteOptions, StrategyResult } from "../types.js";
import type { RegisterEntry } from "@travel/contracts/retention";

export class PhysicalDeleteStrategy implements CategoryPurgeStrategy {
  readonly name = "physical_delete";

  constructor(
    private readonly repo: PurgeRepositoryPort,
    private readonly logger: PurgeLogger,
  ) {}

  async execute(
    entry: RegisterEntry,
    options: StrategyExecuteOptions,
  ): Promise<StrategyResult> {
    const { now, batchSize, interBatchPauseMs, dryRun, correlationId, maxBatches } = options;

    const examined = await this.repo.countExpired(entry.table, now);

    if (dryRun) {
      this.logger.info(
        {
          correlationId,
          category: entry.category,
          entryId: entry.id,
          table: entry.table,
          examined,
          dryRun: true,
        },
        "purge.dry_run: would delete rows",
      );
      return { examined, purged: 0, keysDestroyed: 0, status: "skipped" };
    }

    let totalPurged = 0;
    let batchCount = 0;

    while (batchCount < maxBatches) {
      const deleted = await this.repo.deleteBatch(entry.table, batchSize, now);
      totalPurged += deleted;
      batchCount++;

      this.logger.info(
        {
          correlationId,
          category: entry.category,
          table: entry.table,
          batch: batchCount,
          batchDeleted: deleted,
          totalPurged,
        },
        "purge.batch_deleted",
      );

      if (deleted < batchSize) {
        // No more rows to delete
        break;
      }

      if (batchCount < maxBatches && interBatchPauseMs > 0) {
        await pause(interBatchPauseMs);
      }
    }

    return { examined, purged: totalPurged, keysDestroyed: 0, status: "success" };
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
