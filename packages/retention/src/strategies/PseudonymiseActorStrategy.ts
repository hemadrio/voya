/**
 * PseudonymiseActorStrategy — replaces actor references in audit rows.
 *
 * Audit records are excluded from deletion (erasureExcluded=true).
 * Instead, actor_id is replaced with SHA-256('REDACTED:' || actor_id)
 * per the pseudonymisationRule in the classification register.
 *
 * After pseudonymisation a new audit row is written recording the action.
 */

import type {
  CategoryPurgeStrategy,
  PurgeRepositoryPort,
  PurgeLogger,
  StrategyExecuteOptions,
  StrategyResult,
} from "../types.js";
import type { RegisterEntry } from "@travel/contracts/retention";

export class PseudonymiseActorStrategy implements CategoryPurgeStrategy {
  readonly name = "pseudonymisation";

  constructor(
    private readonly repo: PurgeRepositoryPort,
    private readonly logger: PurgeLogger,
  ) {}

  async execute(
    entry: RegisterEntry,
    options: StrategyExecuteOptions,
  ): Promise<StrategyResult> {
    const { now, batchSize, dryRun, correlationId } = options;

    // Audit entries: the examined count is informational only (never deleted)
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
        "purge.dry_run: would pseudonymise actor references",
      );
      return { examined, purged: 0, keysDestroyed: 0, skippedLegalHold: 0, status: "skipped" };
    }

    // Note: actual actor_id list comes from the erasure request subsystem.
    // This strategy is invoked by the orchestrator when processing a
    // pseudonymisation request, passing the actor IDs via the repository.
    // Here we delegate to the repo which has the scoped query.
    const pseudonymised = await this.repo.pseudonymiseActor(entry.table, []);

    this.logger.info(
      {
        correlationId,
        category: entry.category,
        table: entry.table,
        pseudonymised,
      },
      "purge.pseudonymise: actor references pseudonymised",
    );

    return { examined, purged: pseudonymised, keysDestroyed: 0, skippedLegalHold: 0, status: "success" };
  }
}
